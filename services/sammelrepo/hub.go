package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"maps"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	// A car may install from an index it fetched a while ago: archives no
	// entry points to any more stay this long.
	orphanGrace = 3 * 24 * time.Hour
	keepEvents  = 300
	keepIndexes = 30
	defaultName = "Sammel-Repo"
)

type state struct {
	Name      string                `json:"name"`
	Sources   []*source             `json:"sources"`
	Published map[string]*published `json:"published"`
	Generated int64                 `json:"generated_unix"`
	Orphans   map[string]int64      `json:"orphans"`
	Events    []event               `json:"events"`
}

type source struct {
	ID         string `json:"id"`
	URL        string `json:"url"`
	Name       string `json:"name"`
	Added      int64  `json:"added_unix"`
	Checked    int64  `json:"checked_unix"`
	OK         int64  `json:"ok_unix"`
	Error      string `json:"error,omitempty"`
	ErrorSince int64  `json:"error_since_unix,omitempty"`
	ETag       string `json:"etag,omitempty"`
	// Last good entry per id, compact. Entries are bytes (base64 in
	// state.json): encoding/json would escape U+2028 inside a RawMessage,
	// and the entry would no longer hash as upstream.
	Entries map[string][]byte `json:"entries"`
	Skipped []skip            `json:"skipped,omitempty"`
}

type skip struct {
	ID      string `json:"id"`
	Version string `json:"version"`
	Reason  string `json:"reason"`
}

// published is a package in the combined index. Once published, an id stays
// in the index for good: CoilShift refuses an index from which a package it
// offered disappears.
type published struct {
	Source     string `json:"source"`
	SourceName string `json:"source_name"`
	Entry      []byte `json:"entry"`
	Withdrawn  bool   `json:"withdrawn"` // by this service, because no source offers it any more
	Since      int64  `json:"since_unix"`
	Changed    int64  `json:"changed_unix"`
}

type event struct {
	Unix    int64  `json:"unix"`
	Kind    string `json:"kind"` // neu, update, zurueck, quelle, fehler, hinweis
	Text    string `json:"text"`
	Package string `json:"package,omitempty"`
	Title   string `json:"title,omitempty"`
	Version string `json:"version,omitempty"`
	From    string `json:"from,omitempty"`
	Source  string `json:"source,omitempty"`
}

type hub struct {
	dir       string
	public    *url.URL
	interval  time.Duration
	client    *http.Client
	allowHTTP bool
	now       func() time.Time
	logf      func(string, ...any)

	run sync.Mutex // one refresh at a time
	mu  sync.Mutex // guards the fields below

	st    *state
	index []byte
	etag  string
	busy  map[string]string // source id → what it is doing
	next  time.Time
	stamp int64 // counts saves; the admin page reloads when it moves

	kick chan struct{}
	dl   chan struct{} // download slots
}

func newHub(dir string, public *url.URL, interval time.Duration) *hub {
	return &hub{dir: dir, public: public, interval: interval, client: newClient(false), now: time.Now,
		logf: log.Printf, busy: map[string]string{}, kick: make(chan struct{}, 1), dl: make(chan struct{}, 3)}
}

func (h *hub) load() error {
	for _, d := range []string{"pool", "indexe"} {
		if err := os.MkdirAll(filepath.Join(h.dir, d), 0o700); err != nil {
			return err
		}
	}
	st := &state{Name: defaultName}
	switch b, err := os.ReadFile(filepath.Join(h.dir, "state.json")); {
	case err == nil:
		if err := json.Unmarshal(b, st); err != nil {
			return fmt.Errorf("state.json: %w", err)
		}
	case !errors.Is(err, fs.ErrNotExist):
		return err
	}
	if st.Published == nil {
		st.Published = map[string]*published{}
	}
	if st.Orphans == nil {
		st.Orphans = map[string]int64{}
	}
	if st.Generated == 0 {
		st.Generated = h.now().Unix()
	}
	for _, s := range st.Sources {
		if s.Entries == nil {
			s.Entries = map[string][]byte{}
		}
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	h.st = st
	return h.publishLocked()
}

func newID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// writeFile replaces path atomically.
func writeFile(path string, data []byte) error {
	f, err := os.CreateTemp(filepath.Dir(path), ".tmp-")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	_, err = f.Write(data)
	if err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	return os.Rename(f.Name(), path)
}

// marshal encodes without HTML escaping: json.Marshal would turn < > & in a
// stored entry into < and so on, and the entry would no longer be the
// upstream's bytes.
func marshal(v any) ([]byte, error) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	err := enc.Encode(v)
	return b.Bytes(), err
}

func (h *hub) saveLocked() {
	b, err := marshal(h.st)
	if err == nil {
		err = writeFile(filepath.Join(h.dir, "state.json"), b)
	}
	if err != nil {
		h.logf("Zustand nicht gespeichert: %v", err)
	}
	h.stamp++
}

func (h *hub) eventLocked(e event) {
	e.Unix = h.now().Unix()
	h.st.Events = append(h.st.Events, e)
	if n := len(h.st.Events) - keepEvents; n > 0 {
		h.st.Events = slices.Clone(h.st.Events[n:])
	}
	h.logf("%s: %s", e.Kind, e.Text)
}

func (h *hub) sourceLocked(id string) *source {
	for _, s := range h.st.Sources {
		if s.ID == id {
			return s
		}
	}
	return nil
}

// publishLocked renders the index from the published set.
func (h *hub) publishLocked() error {
	ids := slices.Sorted(maps.Keys(h.st.Published))
	entries := make([][]byte, len(ids))
	for i, id := range ids {
		entries[i] = h.st.Published[id].Entry
	}
	b, err := render(h.st.Name, h.st.Generated, entries)
	if err != nil {
		return err
	}
	if bytes.Equal(b, h.index) {
		return nil
	}
	h.index, h.etag = b, `"`+sha(b)[:24]+`"`
	if err := writeFile(filepath.Join(h.dir, "index.json"), b); err != nil {
		return err
	}
	// Recent indexes stay: if CoilShift refuses the feed, the diff against
	// the last one it took shows why.
	dir := filepath.Join(h.dir, "indexe")
	if err := writeFile(filepath.Join(dir, strconv.FormatInt(h.st.Generated, 10)+".json"), b); err != nil {
		return err
	}
	if old, err := os.ReadDir(dir); err == nil && len(old) > keepIndexes {
		for _, d := range old[:len(old)-keepIndexes] {
			_ = os.Remove(filepath.Join(dir, d.Name()))
		}
	}
	return nil
}

// mergeLocked takes the sources' entries into the published set. For an id
// several sources offer, the one higher in the list wins. An id no source
// offers any more stays, withdrawn.
func (h *hub) mergeLocked(now int64) bool {
	type offer struct {
		s   *source
		raw []byte
	}
	offered := map[string]offer{}
	for _, s := range h.st.Sources {
		for _, id := range slices.Sorted(maps.Keys(s.Entries)) {
			if _, taken := offered[id]; !taken {
				offered[id] = offer{s, s.Entries[id]}
			}
		}
	}
	changed := false
	for _, id := range slices.Sorted(maps.Keys(offered)) {
		o := offered[id]
		n := parse(o.raw)
		e := event{Package: id, Title: n.label(), Version: n.Version, Source: o.s.Name}
		p := h.st.Published[id]
		switch {
		case p == nil:
			h.st.Published[id] = &published{Source: o.s.ID, SourceName: o.s.Name, Entry: o.raw, Since: now, Changed: now}
			e.Kind, e.Text = "neu", fmt.Sprintf("%s %s ist neu im Feed (%s)", e.Title, e.Version, o.s.Name)
			if n.withdrawn() {
				e.Kind, e.Text = "zurueck", fmt.Sprintf("%s %s steht zurückgezogen im Feed (%s)", e.Title, e.Version, o.s.Name)
			}
		case bytes.Equal(p.Entry, o.raw):
			if p.Source != o.s.ID {
				h.eventLocked(event{Kind: "quelle", Package: id, Title: e.Title, Source: o.s.Name,
					Text: fmt.Sprintf("%s kommt jetzt aus %s", e.Title, o.s.Name)})
			}
			p.Source, p.SourceName = o.s.ID, o.s.Name
			continue
		default:
			old := parse(p.Entry)
			switch {
			case n.withdrawn() && !old.withdrawn():
				e.Kind, e.Text = "zurueck", fmt.Sprintf("%s %s vom Anbieter zurückgezogen (%s)", e.Title, e.Version, o.s.Name)
			case p.Withdrawn:
				e.Kind, e.Text = "neu", fmt.Sprintf("%s %s ist wieder im Feed (%s)", e.Title, e.Version, o.s.Name)
			case old.Version != n.Version:
				e.Kind, e.From = "update", old.Version
				e.Text = fmt.Sprintf("%s %s → %s (%s)", e.Title, old.Version, n.Version, o.s.Name)
			default:
				e.Kind, e.Text = "update", fmt.Sprintf("%s %s hat einen geänderten Eintrag (%s)", e.Title, n.Version, o.s.Name)
			}
			*p = published{Source: o.s.ID, SourceName: o.s.Name, Entry: o.raw, Since: p.Since, Changed: now}
		}
		h.eventLocked(e)
		changed = true
	}
	for _, id := range slices.Sorted(maps.Keys(h.st.Published)) {
		p := h.st.Published[id]
		if _, ok := offered[id]; ok || p.Withdrawn {
			continue
		}
		raw, err := withdraw(p.Entry)
		if err != nil {
			h.logf("%s lässt sich nicht zurückziehen: %v", id, err)
			continue
		}
		p.Entry, p.Withdrawn, p.Changed = raw, true, now
		n := parse(raw)
		why := "nicht mehr in " + p.SourceName
		if h.sourceLocked(p.Source) == nil {
			why = "Quelle " + p.SourceName + " entfernt"
		}
		h.eventLocked(event{Kind: "zurueck", Package: id, Title: n.label(), Version: n.Version, Source: p.SourceName,
			Text: fmt.Sprintf("%s %s zurückgezogen, %s", n.label(), n.Version, why)})
		changed = true
	}
	return changed
}

// republishLocked merges, renders and saves after a change of the sources.
func (h *hub) republishLocked() {
	now := h.now().Unix()
	if h.mergeLocked(now) {
		h.st.Generated = now
	}
	if err := h.publishLocked(); err != nil {
		h.logf("Index nicht geschrieben: %v", err)
	}
	h.saveLocked()
}

type pullResult struct {
	id          string
	name        string
	etag        string
	entries     map[string][]byte
	skipped     []skip
	err         error
	notModified bool
}

func (h *hub) progress(id, text string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, ok := h.busy[id]; ok {
		h.busy[id] = text
	}
}

// pooled tells whether every archive the entries point to is in the pool.
func (h *hub) pooled(entries map[string][]byte) bool {
	for _, raw := range entries {
		e := parse(raw)
		fi, err := os.Stat(filepath.Join(h.dir, "pool", e.Archive.SHA256))
		if err != nil || fi.Size() != e.Archive.Bytes {
			return false
		}
	}
	return true
}

func (h *hub) isSelf(u *url.URL) bool {
	return h.public != nil && strings.EqualFold(u.Hostname(), h.public.Hostname())
}

// pull fetches one source and mirrors what is new. An entry that fails a
// check is not taken; the source's previous entry for that id stays.
func (h *hub) pull(ctx context.Context, s *source) pullResult {
	r := pullResult{id: s.ID, name: s.Name, etag: s.ETag, entries: s.Entries}
	u, err := url.Parse(s.URL)
	if err != nil {
		r.err = err
		return r
	}
	etag := s.ETag
	if len(s.Entries) == 0 || !h.pooled(s.Entries) {
		etag = ""
	}
	f, err := h.fetchIndex(ctx, u, etag)
	if err != nil {
		r.err = err
		return r
	}
	if f.notModified {
		r.notModified = true
		return r
	}
	if h.isSelf(f.base) {
		r.err = errors.New("das ist das Sammel-Repo selbst")
		return r
	}
	r.etag = f.etag
	if n := strings.TrimSpace(f.idx.Repository.Name); n != "" {
		r.name = n
	}
	entries := map[string][]byte{}
	var skipped []skip
	keepOld := func(id, version, reason string) {
		skipped = append(skipped, skip{ID: id, Version: version, Reason: reason})
		if old, ok := s.Entries[id]; ok {
			if _, taken := entries[id]; !taken {
				entries[id] = old
			}
		}
	}
	seen := map[string]bool{}
	for i, raw := range f.idx.Packages {
		c, err := compact(raw)
		if err != nil {
			skipped = append(skipped, skip{ID: "?", Reason: "kein gültiges JSON"})
			continue
		}
		e, err := check(c)
		if err != nil {
			keepOld(e.ID, e.Version, err.Error())
			continue
		}
		if seen[e.ID] {
			skipped = append(skipped, skip{ID: e.ID, Version: e.Version, Reason: "steht doppelt im Index, es gilt der erste Eintrag"})
			continue
		}
		seen[e.ID] = true
		src, err := f.base.Parse(e.Archive.URL)
		if err != nil || (src.Scheme != "https" && !h.allowHTTP) {
			keepOld(e.ID, e.Version, "die Adresse des Archivs ist ungültig")
			continue
		}
		h.progress(s.ID, fmt.Sprintf("Archiv %d von %d: %s", i+1, len(f.idx.Packages), e.label()))
		if err := h.mirror(ctx, src, e.Archive.SHA256, e.Archive.Bytes); err != nil {
			keepOld(e.ID, e.Version, "Archiv nicht geladen: "+describe(err).Error())
			continue
		}
		if want := "pool/" + e.Archive.SHA256; e.Archive.URL != want {
			if c, err = setArchiveURL(c, want); err != nil {
				keepOld(e.ID, e.Version, "die Adresse des Archivs lässt sich nicht umschreiben")
				continue
			}
		}
		entries[e.ID] = c
	}
	r.entries, r.skipped = entries, skipped
	return r
}

func (h *hub) applyLocked(results []pullResult, now int64) {
	for _, r := range results {
		s := h.sourceLocked(r.id)
		if s == nil {
			continue // removed while it was fetched
		}
		s.Checked = now
		if r.err != nil {
			if s.Error == "" {
				s.ErrorSince = now
				h.eventLocked(event{Kind: "fehler", Source: s.Name,
					Text: fmt.Sprintf("%s nicht abrufbar: %v. Die zuletzt geladenen Pakete bleiben im Feed.", s.Name, r.err)})
			}
			s.Error = r.err.Error()
			continue
		}
		if s.Error != "" {
			h.eventLocked(event{Kind: "quelle", Source: s.Name, Text: s.Name + " ist wieder abrufbar"})
		}
		s.Error, s.ErrorSince, s.OK = "", 0, now
		if r.notModified {
			continue
		}
		for _, k := range r.skipped {
			if !slices.Contains(s.Skipped, k) {
				h.eventLocked(event{Kind: "hinweis", Package: k.ID, Version: k.Version, Source: s.Name,
					Text: fmt.Sprintf("%s %s aus %s nicht übernommen: %s", k.ID, k.Version, s.Name, k.Reason)})
			}
		}
		s.Name, s.ETag, s.Entries, s.Skipped = r.name, r.etag, r.entries, r.skipped
	}
	if h.mergeLocked(now) {
		h.st.Generated = now
	}
	if err := h.publishLocked(); err != nil {
		h.logf("Index nicht geschrieben: %v", err)
	}
}

// refresh fetches every source once.
func (h *hub) refresh(ctx context.Context) {
	h.run.Lock()
	defer h.run.Unlock()
	h.mu.Lock()
	snaps := make([]source, len(h.st.Sources))
	for i, s := range h.st.Sources {
		snaps[i] = *s
		h.busy[s.ID] = "Index wird abgerufen"
	}
	h.mu.Unlock()
	results := make([]pullResult, len(snaps))
	var wg sync.WaitGroup
	for i := range snaps {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results[i] = h.pull(ctx, &snaps[i])
		}()
	}
	wg.Wait()
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, s := range snaps {
		delete(h.busy, s.ID)
	}
	if ctx.Err() != nil {
		return
	}
	now := h.now()
	h.applyLocked(results, now.Unix())
	h.collectLocked(now)
	h.saveLocked()
}

func (h *hub) loop(ctx context.Context) {
	for {
		h.refresh(ctx)
		h.mu.Lock()
		h.next = h.now().Add(h.interval)
		h.mu.Unlock()
		t := time.NewTimer(h.interval)
		select {
		case <-ctx.Done():
			t.Stop()
			return
		case <-t.C:
		case <-h.kick:
			t.Stop()
		}
	}
}

// trigger asks for a refresh now; the sources show as waiting until it runs.
func (h *hub) trigger() {
	h.mu.Lock()
	for _, s := range h.st.Sources {
		if _, ok := h.busy[s.ID]; !ok {
			h.busy[s.ID] = "wartet auf den Abruf"
		}
	}
	h.mu.Unlock()
	select {
	case h.kick <- struct{}{}:
	default:
	}
}

// collectLocked removes archives no entry has pointed to for orphanGrace.
func (h *hub) collectLocked(now time.Time) {
	refs := map[string]bool{}
	for _, p := range h.st.Published {
		refs[parse(p.Entry).Archive.SHA256] = true
	}
	for _, s := range h.st.Sources {
		for _, raw := range s.Entries {
			refs[parse(raw).Archive.SHA256] = true
		}
	}
	dir := filepath.Join(h.dir, "pool")
	files, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	present := map[string]bool{}
	for _, d := range files {
		name := d.Name()
		if strings.HasPrefix(name, ".tmp-") {
			if fi, err := d.Info(); err == nil && now.Sub(fi.ModTime()) > time.Hour {
				_ = os.Remove(filepath.Join(dir, name))
			}
			continue
		}
		if !shaPattern.MatchString(name) {
			continue
		}
		present[name] = true
		if refs[name] {
			delete(h.st.Orphans, name)
			continue
		}
		since, ok := h.st.Orphans[name]
		if !ok {
			h.st.Orphans[name] = now.Unix()
		} else if now.Sub(time.Unix(since, 0)) >= orphanGrace && os.Remove(filepath.Join(dir, name)) == nil {
			delete(h.st.Orphans, name)
		}
	}
	for name := range h.st.Orphans {
		if !present[name] {
			delete(h.st.Orphans, name)
		}
	}
}

// sourceKey tells two spellings of the same feed apart from different feeds.
func sourceKey(u *url.URL) string {
	p := strings.TrimSuffix(strings.TrimSuffix(u.EscapedPath(), "/index.json"), "/")
	return strings.ToLower(u.Scheme+"://"+u.Host) + p
}

func (h *hub) parseSourceURL(input string) (*url.URL, error) {
	input = strings.TrimSpace(input)
	if input == "" {
		return nil, errors.New("Bitte eine Adresse eingeben.")
	}
	if !strings.Contains(input, "://") {
		input = "https://" + input
	}
	u, err := url.Parse(input)
	if err != nil || u.Host == "" || len(input) > 2000 {
		return nil, errors.New("Das ist keine gültige Adresse.")
	}
	if u.Scheme != "https" && !(h.allowHTTP && u.Scheme == "http") {
		return nil, errors.New("Nur Adressen mit https:// gehen.")
	}
	if u.User != nil {
		return nil, errors.New("Adressen mit Benutzername oder Passwort gehen nicht.")
	}
	u.Fragment = ""
	return u, nil
}

func (h *hub) duplicateLocked(keys ...string) *source {
	for _, s := range h.st.Sources {
		if u, err := url.Parse(s.URL); err == nil && slices.Contains(keys, sourceKey(u)) {
			return s
		}
	}
	return nil
}

// add checks that the address holds a repository index and adds it. The
// archives load in the background.
func (h *hub) add(ctx context.Context, input string) (*source, error) {
	u, err := h.parseSourceURL(input)
	if err != nil {
		return nil, err
	}
	if h.isSelf(u) {
		return nil, errors.New("Das ist das Sammel-Repo selbst.")
	}
	h.mu.Lock()
	dup := h.duplicateLocked(sourceKey(u))
	h.mu.Unlock()
	if dup != nil {
		return nil, fmt.Errorf("Diese Quelle ist schon eingetragen: %s.", dup.Name)
	}
	f, err := h.fetchIndex(ctx, u, "")
	if err != nil {
		return nil, fmt.Errorf("Unter dieser Adresse liegt kein lesbares Repository: %v.", err)
	}
	if h.isSelf(f.base) {
		return nil, errors.New("Das ist das Sammel-Repo selbst.")
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if dup := h.duplicateLocked(sourceKey(u), sourceKey(f.base)); dup != nil {
		return nil, fmt.Errorf("Diese Quelle ist schon eingetragen: %s.", dup.Name)
	}
	name := strings.TrimSpace(f.idx.Repository.Name)
	if name == "" {
		name = u.Host
	}
	s := &source{ID: newID(), URL: u.String(), Name: name, Added: h.now().Unix(), Entries: map[string][]byte{}}
	h.st.Sources = append(h.st.Sources, s)
	h.eventLocked(event{Kind: "quelle", Source: name,
		Text: fmt.Sprintf("Quelle %s hinzugefügt (%d Pakete im Index)", name, len(f.idx.Packages))})
	h.busy[s.ID] = "wartet auf den Abruf"
	h.saveLocked()
	select {
	case h.kick <- struct{}{}:
	default:
	}
	return s, nil
}

// remove drops a source. Its packages stay in the index, withdrawn, unless
// another source offers them.
func (h *hub) remove(id string) (string, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	i := slices.IndexFunc(h.st.Sources, func(s *source) bool { return s.ID == id })
	if i < 0 {
		return "", errors.New("Diese Quelle gibt es nicht mehr.")
	}
	s := h.st.Sources[i]
	h.st.Sources = slices.Delete(h.st.Sources, i, i+1)
	delete(h.busy, id)
	h.eventLocked(event{Kind: "quelle", Source: s.Name, Text: "Quelle " + s.Name + " entfernt"})
	h.republishLocked()
	return s.Name, nil
}

// move shifts a source up or down; the higher one wins for shared ids.
func (h *hub) move(id string, delta int) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	i := slices.IndexFunc(h.st.Sources, func(s *source) bool { return s.ID == id })
	j := i + delta
	if i < 0 || j < 0 || j >= len(h.st.Sources) {
		return errors.New("Diese Quelle lässt sich nicht weiter verschieben.")
	}
	h.st.Sources[i], h.st.Sources[j] = h.st.Sources[j], h.st.Sources[i]
	h.republishLocked()
	return nil
}

func (h *hub) rename(name string) error {
	name = strings.TrimSpace(name)
	if name == "" || len([]rune(name)) > 60 || strings.ContainsFunc(name, func(r rune) bool { return r < 0x20 }) {
		return errors.New("Der Name braucht 1 bis 60 Zeichen.")
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if name == h.st.Name {
		return nil
	}
	h.st.Name = name
	h.st.Generated = h.now().Unix()
	h.eventLocked(event{Kind: "quelle", Text: "Name im Auto: " + name})
	if err := h.publishLocked(); err != nil {
		return err
	}
	h.saveLocked()
	return nil
}
