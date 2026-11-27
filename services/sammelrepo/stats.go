package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io/fs"
	"maps"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"
)

// Cars never fetch the feed themselves: a CoilShift server fetches the index
// and the archives and hands them on. So the counters say how often CoilShift
// fetches and downloads, not how many cars there are. Visitors of the public
// page count once a day by their address and user agent, hashed with a salt
// that lives for one day; no address is stored.

const keepDays = 400

type dayStats struct {
	Fetches   int            `json:"fetches"`   // index requests
	Clients   map[string]int `json:"clients"`   // client name → index requests
	Downloads map[string]int `json:"downloads"` // "id version" → archive downloads
	Views     int            `json:"views"`     // views of the public page
	Visitors  int            `json:"visitors"`  // distinct visitors of it
}

type statsData struct {
	Days  map[string]*dayStats `json:"days"`
	Today string               `json:"today"`
	Salt  []byte               `json:"salt"`
	Seen  map[string]bool      `json:"seen"` // today's hashed visitors
}

type stats struct {
	path string
	now  func() time.Time
	logf func(string, ...any)

	mu    sync.Mutex
	data  statsData
	dirty bool
}

var (
	clientPattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9._-]{0,31}(/[A-Za-z0-9._+-]{1,24})?`)
	botPattern    = regexp.MustCompile(`(?i)bot|crawl|spider|scan|headless|preview|monitor`)
)

func newStats(dir string, logf func(string, ...any)) *stats {
	s := &stats{path: filepath.Join(dir, "statistik.json"), now: time.Now, logf: logf}
	switch b, err := os.ReadFile(s.path); {
	case err == nil:
		_ = json.Unmarshal(b, &s.data)
	case !errors.Is(err, fs.ErrNotExist):
		s.logf("Statistik nicht gelesen: %v", err)
	}
	if s.data.Days == nil {
		s.data.Days = map[string]*dayStats{}
	}
	return s
}

func dayOf(t time.Time) string { return t.In(berlin).Format("2006-01-02") }

func (s *stats) dayLocked() *dayStats {
	today := dayOf(s.now())
	if s.data.Today != today || len(s.data.Salt) != 32 {
		salt := make([]byte, 32)
		_, _ = rand.Read(salt)
		s.data.Today, s.data.Salt, s.data.Seen = today, salt, map[string]bool{}
		cut := dayOf(s.now().AddDate(0, 0, -keepDays))
		for k := range s.data.Days {
			if k < cut {
				delete(s.data.Days, k)
			}
		}
	}
	if s.data.Seen == nil {
		s.data.Seen = map[string]bool{}
	}
	d := s.data.Days[today]
	if d == nil {
		d = &dayStats{}
		s.data.Days[today] = d
	}
	for _, m := range []*map[string]int{&d.Clients, &d.Downloads} {
		if *m == nil {
			*m = map[string]int{}
		}
	}
	return d
}

// firstLocked tells whether this visitor is new today.
func (s *stats) firstLocked(kind string, r *http.Request) bool {
	m := hmac.New(sha256.New, s.data.Salt)
	m.Write([]byte(kind + "|" + rateKey(clientIP(r)) + "|" + r.UserAgent()))
	k := b64.EncodeToString(m.Sum(nil)[:16])
	if s.data.Seen[k] {
		return false
	}
	s.data.Seen[k] = true
	return true
}

// client names the software of a sender by its first product token.
func client(ua string) string {
	switch {
	case ua == "":
		return "ohne Kennung"
	case botPattern.MatchString(ua):
		return "Bot"
	case strings.HasPrefix(ua, "Mozilla/"):
		return "Browser"
	}
	if c := clientPattern.FindString(ua); c != "" {
		return c
	}
	return "unbekannt"
}

func (s *stats) fetch(r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	d := s.dayLocked()
	d.Fetches++
	d.Clients[client(r.UserAgent())]++
	s.dirty = true
}

func (s *stats) download(r *http.Request, pkg string) {
	// A resumed download counts once, at its start.
	if rg := r.Header.Get("Range"); r.Method != http.MethodGet || (rg != "" && !strings.HasPrefix(rg, "bytes=0-")) {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.dayLocked().Downloads[pkg]++
	s.dirty = true
}

func (s *stats) view(r *http.Request) {
	if botPattern.MatchString(r.UserAgent()) {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	d := s.dayLocked()
	d.Views++
	if s.firstLocked("seite", r) {
		d.Visitors++
	}
	s.dirty = true
}

func (s *stats) save() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.dirty {
		return
	}
	b, err := json.Marshal(s.data)
	if err == nil {
		err = writeFile(s.path, b)
	}
	if err != nil {
		s.logf("Statistik nicht gespeichert: %v", err)
		return
	}
	s.dirty = false
}

// days returns copies of the last n days, oldest first, empty days included.
func (s *stats) days(n int) []dayView {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]dayView, n)
	now := s.now()
	for i := range n {
		t := now.AddDate(0, 0, i-n+1)
		out[i].Date = t.In(berlin)
		if d := s.data.Days[dayOf(t)]; d != nil {
			c := *d
			for _, m := range []*map[string]int{&c.Clients, &c.Downloads} {
				*m = maps.Clone(*m)
			}
			out[i].dayStats = c
		}
	}
	return out
}

type dayView struct {
	Date time.Time
	dayStats
}

// DownloadCount sums the day's archive downloads.
func (d dayView) DownloadCount() int {
	n := 0
	for _, v := range d.Downloads {
		n += v
	}
	return n
}

type count struct {
	Key   string
	N     int
	Share float64 // of the largest, for bar widths
	Pct   int     // of the total
}

// ranked sums one counter over days, largest first.
func ranked(days []dayView, pick func(*dayStats) map[string]int, limit int) []count {
	sum := map[string]int{}
	total := 0
	for i := range days {
		for k, n := range pick(&days[i].dayStats) {
			sum[k] += n
			total += n
		}
	}
	out := make([]count, 0, len(sum))
	for k, n := range sum {
		out = append(out, count{Key: k, N: n})
	}
	slices.SortFunc(out, func(a, b count) int {
		if a.N != b.N {
			return b.N - a.N
		}
		return strings.Compare(a.Key, b.Key)
	})
	if len(out) > limit {
		out = out[:limit]
	}
	for i := range out {
		out[i].Share = float64(out[i].N) / float64(out[0].N)
		out[i].Pct = (out[i].N*100 + total/2) / total
	}
	return out
}
