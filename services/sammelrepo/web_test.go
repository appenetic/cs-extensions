package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strings"
	"testing"
	"time"
)

type testSite struct {
	h   *hub
	w   *web
	mux http.Handler
}

func newTestSite(t *testing.T) *testSite {
	t.Helper()
	h := testHub(t)
	hash, err := hashPassword("ein langes Passwort")
	if err != nil {
		t.Fatal(err)
	}
	a, err := newAuth(map[string]string{"sascha": hash}, make([]byte, 32), t.Logf)
	if err != nil {
		t.Fatal(err)
	}
	st := newStats(h.dir, t.Logf)
	w, err := newWeb(h, a, st)
	if err != nil {
		t.Fatal(err)
	}
	return &testSite{h: h, w: w, mux: w.routes()}
}

func (s *testSite) do(method, path string, form url.Values, cookie *http.Cookie, header map[string]string) *httptest.ResponseRecorder {
	var req *http.Request
	if form != nil {
		req = httptest.NewRequest(method, "https://cs.example.org"+path, strings.NewReader(form.Encode()))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	} else {
		req = httptest.NewRequest(method, "https://cs.example.org"+path, nil)
	}
	req.Header.Set("X-Echte-IP", "203.0.113.7")
	for k, v := range header {
		req.Header.Set(k, v)
	}
	if cookie != nil {
		req.AddCookie(cookie)
	}
	rec := httptest.NewRecorder()
	s.mux.ServeHTTP(rec, req)
	return rec
}

func (s *testSite) login(t *testing.T) *http.Cookie {
	t.Helper()
	rec := s.do("POST", "/admin/anmelden", url.Values{"benutzer": {"Sascha"}, "passwort": {"ein langes Passwort"}}, nil,
		map[string]string{"Sec-Fetch-Site": "same-origin"})
	if rec.Code != http.StatusSeeOther {
		t.Fatalf("login: %d %s", rec.Code, rec.Body)
	}
	for _, c := range rec.Result().Cookies() {
		if c.Name == cookieName && c.Secure && c.HttpOnly {
			return c
		}
	}
	t.Fatal("no session cookie")
	return nil
}

var csrfField = regexp.MustCompile(`name="csrf" value="([^"]+)"`)

func TestFeedAndPublicPage(t *testing.T) {
	s := newTestSite(t)
	up := newUpstream(t, "Quelle")
	a := up.archive(100)
	up.set(entryJSON("dev.test.pkg", "1.0.0", "s", a))
	mustAdd(t, s.h, up.url())
	s.h.refresh(context.Background())

	for _, path := range []string{"/", "/index.json"} {
		rec := s.do("GET", path, nil, nil, map[string]string{"User-Agent": "Go-http-client/2.0"})
		if rec.Code != 200 || !strings.HasPrefix(rec.Header().Get("Content-Type"), "application/json") {
			t.Fatalf("%s: %d %s", path, rec.Code, rec.Header().Get("Content-Type"))
		}
		if _, ok := publishedEntries(t, rec.Body.Bytes())["dev.test.pkg"]; !ok {
			t.Fatalf("%s: package missing", path)
		}
		etag := rec.Header().Get("ETag")
		if again := s.do("GET", path, nil, nil, map[string]string{"If-None-Match": etag, "User-Agent": "Go-http-client/2.0"}); again.Code != http.StatusNotModified {
			t.Fatalf("%s: revalidation gave %d", path, again.Code)
		}
	}
	page := s.do("GET", "/", nil, nil, map[string]string{"Accept": "text/html,application/xhtml+xml", "User-Agent": "Mozilla/5.0"})
	body := page.Body.String()
	if page.Code != 200 || !strings.Contains(body, "Titel dev.test.pkg") || !strings.Contains(body, "https://cs.example.org/index.json") {
		t.Fatalf("public page: %d\n%s", page.Code, body)
	}
	if !strings.Contains(page.Header().Get("Content-Security-Policy"), "default-src 'none'") {
		t.Fatal("public page without CSP")
	}
	arc := s.do("GET", "/pool/"+sha(a), nil, nil, nil)
	if arc.Code != 200 || arc.Body.Len() != len(a) {
		t.Fatalf("archive: %d %d", arc.Code, arc.Body.Len())
	}
	if s.do("GET", "/pool/../state.json", nil, nil, nil).Code == 200 || s.do("GET", "/pool/abc", nil, nil, nil).Code != 404 {
		t.Fatal("pool serves more than archives")
	}
	day := s.w.stats.days(1)[0]
	if day.Fetches != 4 || day.Clients["Go-http-client/2.0"] != 4 || day.Downloads["dev.test.pkg 1.0.0"] != 1 || day.Views != 1 {
		t.Fatalf("counts: %+v", day.dayStats)
	}
	if b, _ := json.Marshal(s.w.stats.data); strings.Contains(string(b), "203.0.113") {
		t.Fatal("an address reached the statistics file")
	}
}

func TestAdminNeedsLoginAndSameOriginForms(t *testing.T) {
	s := newTestSite(t)
	if rec := s.do("GET", "/admin", nil, nil, nil); rec.Code != http.StatusSeeOther ||
		rec.Header().Get("Location") != "/admin/anmelden" {
		t.Fatalf("admin without login: %d %s", rec.Code, rec.Header().Get("Location"))
	}
	if rec := s.do("POST", "/admin/anmelden", url.Values{"benutzer": {"sascha"}, "passwort": {"falsch falsch falsch"}}, nil,
		map[string]string{"Sec-Fetch-Site": "same-origin"}); rec.Code != http.StatusUnauthorized {
		t.Fatalf("wrong password: %d", rec.Code)
	}
	if rec := s.do("POST", "/admin/anmelden", url.Values{"benutzer": {"sascha"}, "passwort": {"ein langes Passwort"}}, nil,
		map[string]string{"Sec-Fetch-Site": "cross-site"}); rec.Code != http.StatusBadRequest {
		t.Fatalf("cross-site login: %d", rec.Code)
	}
	c := s.login(t)
	page := s.do("GET", "/admin", nil, c, nil)
	m := csrfField.FindStringSubmatch(page.Body.String())
	if page.Code != 200 || m == nil {
		t.Fatalf("admin page: %d", page.Code)
	}
	up := newUpstream(t, "Neu")
	up.set(entryJSON("dev.test.new", "1.0.0", "s", up.archive(10)))
	if rec := s.do("POST", "/admin/quellen", url.Values{"url": {up.url()}}, c,
		map[string]string{"Sec-Fetch-Site": "same-origin"}); rec.Code != http.StatusForbidden {
		t.Fatalf("form without csrf: %d", rec.Code)
	}
	if rec := s.do("POST", "/admin/quellen", url.Values{"url": {up.url()}, "csrf": {m[1]}}, c,
		map[string]string{"Sec-Fetch-Site": "same-site"}); rec.Code != http.StatusForbidden {
		t.Fatalf("form from another site: %d", rec.Code)
	}
	if rec := s.do("POST", "/admin/quellen", url.Values{"url": {up.url()}, "csrf": {m[1]}}, c,
		map[string]string{"Sec-Fetch-Site": "same-origin"}); rec.Code != http.StatusSeeOther {
		t.Fatalf("add source: %d %s", rec.Code, rec.Body)
	}
	if len(s.h.st.Sources) != 1 {
		t.Fatal("source not added")
	}
	bad := s.do("POST", "/admin/quellen", url.Values{"url": {up.srv.URL + "/nix"}, "csrf": {m[1]}}, c,
		map[string]string{"Sec-Fetch-Site": "same-origin"})
	if bad.Code != http.StatusUnprocessableEntity || !strings.Contains(bad.Body.String(), "kein lesbares Repository") {
		t.Fatalf("bad source: %d", bad.Code)
	}
	s.h.refresh(context.Background())
	for _, path := range []string{"/admin", "/admin/statistik", "/admin/zustand"} {
		if rec := s.do("GET", path, nil, c, nil); rec.Code != 200 {
			t.Fatalf("%s: %d\n%s", path, rec.Code, rec.Body)
		}
	}
	out := s.do("POST", "/admin/abmelden", url.Values{"csrf": {m[1]}}, c, map[string]string{"Sec-Fetch-Site": "same-origin"})
	if out.Code != http.StatusSeeOther || !strings.Contains(out.Header().Get("Set-Cookie"), "Max-Age=0") {
		t.Fatalf("logout: %d %s", out.Code, out.Header().Get("Set-Cookie"))
	}
}

func TestLoginLimiter(t *testing.T) {
	s := newTestSite(t)
	for i := range maxFails {
		rec := s.do("POST", "/admin/anmelden", url.Values{"benutzer": {"sascha"}, "passwort": {"nein"}}, nil, nil)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("attempt %d: %d", i, rec.Code)
		}
	}
	rec := s.do("POST", "/admin/anmelden", url.Values{"benutzer": {"sascha"}, "passwort": {"ein langes Passwort"}}, nil, nil)
	if rec.Code != http.StatusTooManyRequests || rec.Header().Get("Retry-After") == "" {
		t.Fatalf("sixth attempt: %d", rec.Code)
	}
}

func TestTokens(t *testing.T) {
	hash, _ := hashPassword("ein langes Passwort")
	a, _ := newAuth(map[string]string{"sascha": hash}, make([]byte, 32), t.Logf)
	tok := a.token("sascha", time.Hour)
	if a.tokenUser(tok) != "sascha" {
		t.Fatal("fresh token refused")
	}
	if a.tokenUser(tok[:len(tok)-2]+"AA") != "" {
		t.Fatal("forged signature accepted")
	}
	now := time.Now()
	a.now = func() time.Time { return now.Add(2 * time.Hour) }
	if a.tokenUser(tok) != "" {
		t.Fatal("expired token accepted")
	}
	a.now = time.Now
	other, _ := hashPassword("ein anderes Passwort")
	a.users["sascha"] = other
	if a.tokenUser(tok) != "" {
		t.Fatal("token survived a password change")
	}
	if !checkPassword(other, "ein anderes Passwort") || checkPassword(other, "ein anderes passwort") {
		t.Fatal("password check")
	}
}

func TestNiceTop(t *testing.T) {
	for in, want := range map[int]int{0: 4, 3: 4, 5: 8, 9: 20, 21: 40, 41: 80, 81: 200, 450: 800} {
		if got := niceTop(in); got != want {
			t.Errorf("niceTop(%d) = %d, want %d", in, got, want)
		}
	}
}
