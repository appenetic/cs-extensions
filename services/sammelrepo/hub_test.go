package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	pbkdfRounds = 100000
	os.Exit(m.Run())
}

// upstream is a fake repository: /feed redirects to /feed/ like GitHub
// Pages, the index sits at /feed/ and /feed/index.json, archives in /feed/pool/.
type upstream struct {
	mu       sync.Mutex
	name     string
	packages []string
	archives map[string][]byte
	status   int
	fetches  int
	srv      *httptest.Server
}

func newUpstream(t *testing.T, name string) *upstream {
	u := &upstream{name: name, archives: map[string][]byte{}, status: http.StatusOK}
	mux := http.NewServeMux()
	mux.HandleFunc("/feed", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/feed/", http.StatusMovedPermanently)
	})
	mux.HandleFunc("/feed/", func(w http.ResponseWriter, r *http.Request) {
		u.mu.Lock()
		defer u.mu.Unlock()
		if sum, ok := strings.CutPrefix(r.URL.Path, "/feed/pool/"); ok {
			b, ok := u.archives[sum]
			if !ok {
				http.NotFound(w, r)
				return
			}
			_, _ = w.Write(b)
			return
		}
		u.fetches++
		if u.status != http.StatusOK {
			w.WriteHeader(u.status)
			return
		}
		raw := `{"schema":1,"repository":{"name":` + string(quote(u.name)) + `},"packages":[` +
			strings.Join(u.packages, ",") + `]}`
		var pretty bytes.Buffer
		if err := json.Indent(&pretty, []byte(raw), "", "    "); err != nil {
			t.Errorf("fake index: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(pretty.Bytes())
	})
	u.srv = httptest.NewServer(mux)
	t.Cleanup(u.srv.Close)
	return u
}

func (u *upstream) url() string { return u.srv.URL + "/feed" }

func (u *upstream) set(entries ...string) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.packages = entries
}

// archive registers random archive bytes and returns them.
func (u *upstream) archive(n int) []byte {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	u.mu.Lock()
	defer u.mu.Unlock()
	u.archives[sha(b)] = b
	return b
}

// entryJSON writes an entry the way a foreign feed might: odd key order,
// non-ASCII, HTML characters, U+2028, escapes and number spellings that a
// re-encoding would change.
func entryJSON(id, version, summary string, archive []byte) string {
	// JSON escape sequences as text: \ + u00e9 is "é" spelled as an escape.
	esc := func(hex string) string { return "\\" + "u" + hex }
	ls := string(rune(0x2028))
	manifest := `{"schema":1,"id":` + string(quote(id)) + `,"version":` + string(quote(version)) +
		`,"sdk":">=1.0 <2","title":"Titel <b>&amp;</b> Rufwörter ` + esc("00e9") + ` ` + ls + ` \/","summary":` + string(quote(summary)) +
		`,"settings":[{"id":"x","default":1.0,"max":1e3}],"hooks":{"apply":{"run":"hooks/apply.sh"}}}`
	mc, _ := compact([]byte(manifest))
	return `{"archive":{"sha256":"` + sha(archive) + `","bytes":` + fmt.Sprint(len(archive)) +
		`,"url":"pool/` + sha(archive) + `"},"id":` + string(quote(id)) + `,"version":` + string(quote(version)) +
		`,"title":"Titel ` + id + ` <b>&</b>","sdk":">=1.0 <2","manifest":` + manifest +
		`,"manifest_sha256":"` + sha(mc) + `","license":"MIT","n":1.0,"arr":[1,[2,{"x":"` + esc("2028") + ` ` + ls + `"}]]}`
}

func testHub(t *testing.T) *hub {
	t.Helper()
	pub, _ := url.Parse("https://cs.example.org")
	h := newHub(t.TempDir(), pub, time.Hour)
	h.client = newClient(true)
	h.allowHTTP = true
	h.logf = t.Logf
	if err := h.load(); err != nil {
		t.Fatal(err)
	}
	return h
}

func publishedEntries(t *testing.T, index []byte) map[string][]byte {
	t.Helper()
	var idx struct {
		Schema   int               `json:"schema"`
		Packages []json.RawMessage `json:"packages"`
	}
	if err := json.Unmarshal(index, &idx); err != nil || idx.Schema != 1 {
		t.Fatalf("index does not parse: %v", err)
	}
	out := map[string][]byte{}
	for _, raw := range idx.Packages {
		c, err := compact(raw)
		if err != nil {
			t.Fatal(err)
		}
		out[parse(c).ID] = c
	}
	return out
}

func mustAdd(t *testing.T, h *hub, u string) *source {
	t.Helper()
	s, err := h.add(context.Background(), u)
	if err != nil {
		t.Fatalf("add %s: %v", u, err)
	}
	return s
}

func TestEntriesPassThroughByteForByte(t *testing.T) {
	up := newUpstream(t, "Fremd")
	a, b := up.archive(3000), up.archive(5000)
	ea := entryJSON("dev.test.alpha", "1.0.0", "Zusammenfassung mit "+string(rune(0x2028))+" und <script>", a)
	eb := entryJSON("dev.test.beta", "0.2.0-alpha.1", "Ölwechsel & Co.", b)
	up.set(ea, eb)
	h := testHub(t)
	mustAdd(t, h, up.url())
	h.refresh(context.Background())

	got := publishedEntries(t, h.index)
	for _, want := range []string{ea, eb} {
		wc, _ := compact([]byte(want))
		id := parse(wc).ID
		if !bytes.Equal(got[id], wc) {
			t.Fatalf("%s changed on the way:\n got %s\nwant %s", id, got[id], wc)
		}
		// The entry hash the car shows as entry_sha256 and the manifest hash stay.
		if sha(got[id]) != sha(wc) {
			t.Fatalf("%s: entry hash changed", id)
		}
		if _, err := check(got[id]); err != nil {
			t.Fatalf("%s no longer passes: %v", id, err)
		}
	}
	for _, arc := range [][]byte{a, b} {
		on, err := os.ReadFile(filepath.Join(h.dir, "pool", sha(arc)))
		if err != nil || !bytes.Equal(on, arc) {
			t.Fatalf("archive not mirrored: %v", err)
		}
	}

	// A restart reads the state back and serves the same bytes: no HTML
	// escaping on the way to disk and back.
	h2 := newHub(h.dir, h.public, time.Hour)
	h2.logf = t.Logf
	if err := h2.load(); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(h2.index, h.index) {
		a, b := string(h.index), string(h2.index)
		i := 0
		for i < len(a) && i < len(b) && a[i] == b[i] {
			i++
		}
		t.Fatalf("index changed across a restart at byte %d:\n before …%q\n after  …%q", i, a[max(0, i-80):min(len(a), i+80)], b[max(0, i-80):min(len(b), i+80)])
	}
	if bytes.Contains(h.index, []byte("\\"+"u003c")) {
		t.Fatalf("index holds HTML escapes")
	}
}

func TestArchiveResolvesAgainstRedirectedIndex(t *testing.T) {
	up := newUpstream(t, "Umgeleitet")
	a := up.archive(100)
	up.set(entryJSON("dev.test.redirect", "1.0.0", "s", a))
	h := testHub(t)
	mustAdd(t, h, up.url()) // /feed → /feed/, so pool/<sha> is /feed/pool/<sha>
	h.refresh(context.Background())
	if _, ok := publishedEntries(t, h.index)["dev.test.redirect"]; !ok {
		t.Fatal("package missing; the archive resolved against the wrong base")
	}
}

func TestRemovedSourceLeavesPackagesWithdrawn(t *testing.T) {
	up := newUpstream(t, "Weg")
	a := up.archive(100)
	up.set(entryJSON("dev.test.gone", "1.0.0", "s", a))
	h := testHub(t)
	s := mustAdd(t, h, up.url())
	h.refresh(context.Background())
	if _, err := h.remove(s.ID); err != nil {
		t.Fatal(err)
	}
	e := parse(publishedEntries(t, h.index)["dev.test.gone"])
	if e.ID == "" || !e.withdrawn() {
		t.Fatalf("package must stay in the index, withdrawn: %+v", e)
	}
	if _, err := os.Stat(filepath.Join(h.dir, "pool", sha(a))); err != nil {
		t.Fatal("a withdrawn package keeps its archive")
	}
	// Added again, it is offered again.
	mustAdd(t, h, up.url())
	h.refresh(context.Background())
	if parse(publishedEntries(t, h.index)["dev.test.gone"]).withdrawn() {
		t.Fatal("package should be back")
	}
}

func TestDroppedPackageIsWithdrawnAndFailureKeepsAll(t *testing.T) {
	up := newUpstream(t, "Quelle")
	a, b := up.archive(100), up.archive(200)
	up.set(entryJSON("dev.test.keep", "1.0.0", "s", a), entryJSON("dev.test.drop", "1.0.0", "s", b))
	h := testHub(t)
	mustAdd(t, h, up.url())
	h.refresh(context.Background())
	before := publishedEntries(t, h.index)

	up.mu.Lock()
	up.status = http.StatusInternalServerError
	up.mu.Unlock()
	h.refresh(context.Background())
	if !bytes.Equal(publishedEntries(t, h.index)["dev.test.keep"], before["dev.test.keep"]) ||
		!bytes.Equal(publishedEntries(t, h.index)["dev.test.drop"], before["dev.test.drop"]) {
		t.Fatal("a failing source must leave its packages as they were")
	}
	if h.st.Sources[0].Error == "" {
		t.Fatal("error not recorded")
	}

	up.mu.Lock()
	up.status = http.StatusOK
	up.mu.Unlock()
	up.set(entryJSON("dev.test.keep", "1.0.0", "s", a))
	h.refresh(context.Background())
	got := publishedEntries(t, h.index)
	if !parse(got["dev.test.drop"]).withdrawn() || parse(got["dev.test.keep"]).withdrawn() {
		t.Fatal("the dropped package must be withdrawn, the other one not")
	}
	if h.st.Sources[0].Error != "" {
		t.Fatal("error should clear")
	}
}

func TestBrokenNewVersionKeepsTheOldOne(t *testing.T) {
	up := newUpstream(t, "Quelle")
	a := up.archive(100)
	up.set(entryJSON("dev.test.pkg", "1.0.0", "s", a))
	h := testHub(t)
	mustAdd(t, h, up.url())
	h.refresh(context.Background())

	cases := map[string]string{
		"long summary": entryJSON("dev.test.pkg", "1.1.0", strings.Repeat("ä", 140), up.archive(100)),
		"bad manifest hash": strings.Replace(entryJSON("dev.test.pkg", "1.1.0", "s", up.archive(100)),
			`"manifest_sha256":"`, `"manifest_sha256":"0`, 1),
		"archive missing": entryJSON("dev.test.pkg", "1.1.0", "s", []byte("never served")),
	}
	for name, broken := range cases {
		up.set(broken)
		h.refresh(context.Background())
		if v := parse(publishedEntries(t, h.index)["dev.test.pkg"]).Version; v != "1.0.0" {
			t.Fatalf("%s: published %s, want the old 1.0.0", name, v)
		}
		if len(h.st.Sources[0].Skipped) != 1 {
			t.Fatalf("%s: skip not recorded: %+v", name, h.st.Sources[0].Skipped)
		}
	}
	// An archive whose bytes do not match its hash.
	evil := up.archive(100)
	e := entryJSON("dev.test.pkg", "1.2.0", "s", evil)
	up.mu.Lock()
	up.archives[sha(evil)] = []byte("other bytes")
	up.mu.Unlock()
	up.set(e)
	h.refresh(context.Background())
	if v := parse(publishedEntries(t, h.index)["dev.test.pkg"]).Version; v != "1.0.0" {
		t.Fatalf("tampered archive published as %s", v)
	}
	if _, err := os.Stat(filepath.Join(h.dir, "pool", sha(evil))); err == nil {
		t.Fatal("tampered archive landed in the pool")
	}
	// A good new version goes through.
	up.set(entryJSON("dev.test.pkg", "2.0.0", "s", up.archive(100)))
	h.refresh(context.Background())
	if v := parse(publishedEntries(t, h.index)["dev.test.pkg"]).Version; v != "2.0.0" {
		t.Fatalf("published %s, want 2.0.0", v)
	}
}

func TestHigherSourceWinsForSharedIDs(t *testing.T) {
	one, two := newUpstream(t, "Eins"), newUpstream(t, "Zwei")
	one.set(entryJSON("dev.test.same", "1.0.0", "s", one.archive(100)))
	two.set(entryJSON("dev.test.same", "9.0.0", "s", two.archive(100)))
	h := testHub(t)
	mustAdd(t, h, one.url())
	s2 := mustAdd(t, h, two.url())
	h.refresh(context.Background())
	if v := parse(publishedEntries(t, h.index)["dev.test.same"]).Version; v != "1.0.0" {
		t.Fatalf("first source should win, got %s", v)
	}
	if err := h.move(s2.ID, -1); err != nil {
		t.Fatal(err)
	}
	if v := parse(publishedEntries(t, h.index)["dev.test.same"]).Version; v != "9.0.0" {
		t.Fatalf("moved-up source should win, got %s", v)
	}
	if n := len(publishedEntries(t, h.index)); n != 1 {
		t.Fatalf("an id must be in the index once, got %d entries", n)
	}
}

func TestSourceChecks(t *testing.T) {
	up := newUpstream(t, "Quelle")
	up.set()
	h := testHub(t)
	mustAdd(t, h, up.url())
	if _, err := h.add(context.Background(), up.url()+"/index.json"); err == nil {
		t.Fatal("the same feed spelled differently was added twice")
	}
	if _, err := h.add(context.Background(), "https://cs.example.org/index.json"); err == nil {
		t.Fatal("the service itself was accepted as a source")
	}
	if _, err := h.add(context.Background(), up.srv.URL+"/nothing-here"); err == nil {
		t.Fatal("a page without an index was accepted")
	}
	h.allowHTTP = false
	if _, err := h.add(context.Background(), "http://example.org/feed"); err == nil {
		t.Fatal("plain http was accepted")
	}
}

func TestCollectKeepsReferencedAndRecentOrphans(t *testing.T) {
	up := newUpstream(t, "Quelle")
	a := up.archive(100)
	up.set(entryJSON("dev.test.pkg", "1.0.0", "s", a))
	h := testHub(t)
	mustAdd(t, h, up.url())
	h.refresh(context.Background())
	b := up.archive(100)
	up.set(entryJSON("dev.test.pkg", "1.1.0", "s", b))
	h.refresh(context.Background())

	now := time.Now()
	h.now = func() time.Time { return now }
	h.refresh(context.Background())
	if _, err := os.Stat(filepath.Join(h.dir, "pool", sha(a))); err != nil {
		t.Fatal("the old archive went at once; a car may still install it")
	}
	h.now = func() time.Time { return now.Add(orphanGrace + time.Minute) }
	h.refresh(context.Background())
	if _, err := os.Stat(filepath.Join(h.dir, "pool", sha(a))); err == nil {
		t.Fatal("the old archive should be gone after the grace period")
	}
	if _, err := os.Stat(filepath.Join(h.dir, "pool", sha(b))); err != nil {
		t.Fatal("the current archive was removed")
	}
}

func TestPublicAddrBlocksOwnNetworks(t *testing.T) {
	for _, tc := range []struct {
		ip string
		ok bool
	}{
		{"140.82.112.3", true}, {"185.199.108.153", true}, {"2606:50c0:8000::153", true},
		{"127.0.0.1", false}, {"10.1.2.3", false}, {"192.168.1.7", false}, {"172.16.0.1", false},
		{"100.90.208.47", false}, {"169.254.169.254", false}, {"0.0.0.0", false}, {"::1", false},
		{"fd00::1", false}, {"fe80::1", false}, {"::ffff:127.0.0.1", false}, {"224.0.0.1", false},
	} {
		ip, err := netipParse(tc.ip)
		if err != nil {
			t.Fatal(err)
		}
		if publicAddr(ip) != tc.ok {
			t.Errorf("publicAddr(%s) = %v, want %v", tc.ip, !tc.ok, tc.ok)
		}
	}
	// The guard holds on the real dial too.
	srv := httptest.NewServer(http.NotFoundHandler())
	defer srv.Close()
	_, err := newClient(false).Get(srv.URL)
	if err == nil || describe(err).Error() != "die Adresse liegt im eigenen oder einem privaten Netz" {
		t.Fatalf("loopback was reachable: %v", err)
	}
}
