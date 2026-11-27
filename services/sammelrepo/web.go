package main

import (
	"bytes"
	"embed"
	"encoding/json"
	"fmt"
	"html/template"
	"maps"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"
	_ "time/tzdata"
)

//go:embed web
var webFiles embed.FS

var berlin = func() *time.Location {
	if loc, err := time.LoadLocation("Europe/Berlin"); err == nil {
		return loc
	}
	return time.UTC
}()

const csp = "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; " +
	"form-action 'self'; frame-ancestors 'none'; base-uri 'none'"

type web struct {
	h      *hub
	a      *auth
	stats  *stats
	tmpl   *template.Template
	static map[string][]byte
	assets map[string]string // file → versioned URL
}

func newWeb(h *hub, a *auth, st *stats) (*web, error) {
	w := &web{h: h, a: a, stats: st, static: map[string][]byte{}, assets: map[string]string{}}
	for _, name := range []string{"app.css", "app.js", "icon.svg"} {
		b, err := webFiles.ReadFile("web/" + name)
		if err != nil {
			return nil, err
		}
		if name == "app.css" {
			// Bar sizes as classes: the CSP allows no inline styles.
			var gen strings.Builder
			for i := 0; i <= 100; i++ {
				fmt.Fprintf(&gen, ".w%d{width:%d%%}.h%d{height:%d%%}\n", i, i, i, i)
			}
			b = append(b, gen.String()...)
		}
		w.static[name] = b
		w.assets[name] = "/static/" + name + "?v=" + sha(b)[:10]
	}
	funcs := template.FuncMap{
		"asset": func(name string) string { return w.assets[name] },
		"icon":  func() template.HTML { return template.HTML(icon) },
	}
	t, err := template.New("").Funcs(funcs).ParseFS(webFiles, "web/*.html")
	if err != nil {
		return nil, err
	}
	w.tmpl = t
	return w, nil
}

const icon = `<svg class="logo" viewBox="0 0 32 32" aria-hidden="true"><rect class="bg" width="32" height="32" rx="8"/>` +
	`<path class="fg" d="M8 8h4v4H8zM14 8h4v4h-4zM20 8h4v4h-4zM8 15h16v3H8zM11 21h10v3H11z"/></svg>`

func (w *web) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", w.home)
	mux.HandleFunc("GET /index.json", w.feed)
	mux.HandleFunc("GET /pool/{sha}", w.archive)
	mux.HandleFunc("GET /robots.txt", func(rw http.ResponseWriter, r *http.Request) {
		rw.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = rw.Write([]byte("User-agent: *\nDisallow: /\n"))
	})
	mux.HandleFunc("GET /static/{file}", w.asset)
	mux.HandleFunc("GET /admin", w.private(w.overview))
	mux.HandleFunc("GET /admin/{$}", func(rw http.ResponseWriter, r *http.Request) {
		http.Redirect(rw, r, "/admin", http.StatusMovedPermanently)
	})
	mux.HandleFunc("GET /admin/statistik", w.private(w.statistics))
	mux.HandleFunc("GET /admin/zustand", w.private(w.status))
	mux.HandleFunc("GET /admin/anmelden", w.loginForm)
	mux.HandleFunc("POST /admin/anmelden", w.login)
	mux.HandleFunc("POST /admin/abmelden", w.private(w.logout))
	mux.HandleFunc("POST /admin/quellen", w.private(w.addSource))
	mux.HandleFunc("POST /admin/quellen/{id}/{aktion}", w.private(w.sourceAction))
	mux.HandleFunc("POST /admin/aktualisieren", w.private(w.refreshNow))
	mux.HandleFunc("POST /admin/name", w.private(w.rename))
	return mux
}

// ---------------------------------------------------------------- feed

// home serves the index to CoilShift and the page to browsers: the car's
// fetcher does not ask for HTML.
func (w *web) home(rw http.ResponseWriter, r *http.Request) {
	rw.Header().Set("Vary", "Accept")
	if strings.Contains(r.Header.Get("Accept"), "text/html") {
		w.publicPage(rw, r)
		return
	}
	w.feed(rw, r)
}

func (w *web) feed(rw http.ResponseWriter, r *http.Request) {
	w.h.mu.Lock()
	b, etag, mod := w.h.index, w.h.etag, time.Unix(w.h.st.Generated, 0)
	w.h.mu.Unlock()
	if r.Method == http.MethodGet {
		w.stats.fetch(r)
	}
	rw.Header().Set("Content-Type", "application/json; charset=utf-8")
	rw.Header().Set("Cache-Control", "no-cache")
	rw.Header().Set("ETag", etag)
	http.ServeContent(rw, r, "", mod, bytes.NewReader(b))
}

func (w *web) archive(rw http.ResponseWriter, r *http.Request) {
	sum := r.PathValue("sha")
	if !shaPattern.MatchString(sum) {
		http.NotFound(rw, r)
		return
	}
	f, err := os.Open(filepath.Join(w.h.dir, "pool", sum))
	if err != nil {
		http.NotFound(rw, r)
		return
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		http.NotFound(rw, r)
		return
	}
	w.stats.download(r, w.h.packageOf(sum))
	rw.Header().Set("Content-Type", "application/octet-stream")
	rw.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	rw.Header().Set("ETag", `"`+sum+`"`)
	http.ServeContent(rw, r, "", fi.ModTime(), f)
}

// packageOf names the package an archive belongs to, for the download count.
func (h *hub) packageOf(sum string) string {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, p := range h.st.Published {
		if e := parse(p.Entry); e.Archive.SHA256 == sum {
			return e.ID + " " + e.Version
		}
	}
	for _, s := range h.st.Sources {
		for _, raw := range s.Entries {
			if e := parse(raw); e.Archive.SHA256 == sum {
				return e.ID + " " + e.Version
			}
		}
	}
	return "älteres Archiv"
}

func (w *web) asset(rw http.ResponseWriter, r *http.Request) {
	name := r.PathValue("file")
	b, ok := w.static[name]
	if !ok {
		http.NotFound(rw, r)
		return
	}
	types := map[string]string{".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
		".svg": "image/svg+xml"}
	rw.Header().Set("Content-Type", types[filepath.Ext(name)])
	rw.Header().Set("Cache-Control", "public, max-age=604800")
	_, _ = rw.Write(b)
}

// ---------------------------------------------------------------- pages

func (w *web) render(rw http.ResponseWriter, status int, name string, data any) {
	var b bytes.Buffer
	if err := w.tmpl.ExecuteTemplate(&b, name, data); err != nil {
		w.h.logf("Seite %s: %v", name, err)
		http.Error(rw, "Interner Fehler", http.StatusInternalServerError)
		return
	}
	hd := rw.Header()
	hd.Set("Content-Type", "text/html; charset=utf-8")
	hd.Set("Content-Security-Policy", csp)
	hd.Set("X-Frame-Options", "DENY")
	if hd.Get("Cache-Control") == "" {
		hd.Set("Cache-Control", "no-store")
	}
	rw.WriteHeader(status)
	_, _ = rw.Write(b.Bytes())
}

func when(t int64) string {
	if t == 0 {
		return "–"
	}
	tm := time.Unix(t, 0).In(berlin)
	if tm.Year() == time.Now().In(berlin).Year() {
		return tm.Format("02.01. 15:04")
	}
	return tm.Format("02.01.2006 15:04")
}

func ago(now time.Time, t int64) string {
	if t == 0 {
		return "noch nie"
	}
	d := now.Sub(time.Unix(t, 0))
	switch {
	case d < time.Minute:
		return "gerade eben"
	case d < time.Hour:
		return fmt.Sprintf("vor %d Min.", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("vor %d Std.", int(d.Hours()))
	}
	return "am " + when(t)
}

func (w *web) feedURL() string {
	if w.h.public == nil {
		return "/index.json"
	}
	return strings.TrimSuffix(w.h.public.String(), "/") + "/index.json"
}

type packageView struct {
	ID, Title, Version, Source, Status, Class, Changed string
	Withdrawn                                          bool
}

type eventView struct {
	Kind, Text, When, ISO, Title, What, Source string
}

type sourceView struct {
	ID, Name, URL, State, StateText string
	Count                           int
	Notes                           []string
	First, Last                     bool
}

func (h *hub) packagesLocked(now time.Time) []packageView {
	skipped := map[string]skip{}
	for _, s := range h.st.Sources {
		for _, k := range s.Skipped {
			skipped[s.ID+"|"+k.ID] = k
		}
	}
	var out []packageView
	for _, id := range slices.Sorted(maps.Keys(h.st.Published)) {
		p := h.st.Published[id]
		e := parse(p.Entry)
		v := packageView{ID: id, Title: e.label(), Version: e.Version, Source: p.SourceName,
			Changed: ago(now, p.Changed), Status: "im Feed", Class: "ok"}
		switch {
		case p.Withdrawn && h.sourceLocked(p.Source) == nil:
			v.Status, v.Class, v.Withdrawn = "zurückgezogen, Quelle entfernt", "muted", true
		case p.Withdrawn:
			v.Status, v.Class, v.Withdrawn = "zurückgezogen, nicht mehr im Repository", "muted", true
		case e.withdrawn():
			v.Status, v.Class, v.Withdrawn = "vom Anbieter zurückgezogen", "muted", true
		}
		if k, ok := skipped[p.Source+"|"+id]; ok && !v.Withdrawn {
			v.Status, v.Class = "im Feed, "+k.Version+" nicht übernommen", "warn"
		}
		out = append(out, v)
	}
	slices.SortStableFunc(out, func(a, b packageView) int {
		if a.Withdrawn != b.Withdrawn {
			if a.Withdrawn {
				return 1
			}
			return -1
		}
		return strings.Compare(strings.ToLower(a.Title), strings.ToLower(b.Title))
	})
	return out
}

func (h *hub) eventsLocked(public bool, limit int) []eventView {
	var out []eventView
	for i := len(h.st.Events) - 1; i >= 0 && len(out) < limit; i-- {
		e := h.st.Events[i]
		if public && e.Kind != "neu" && e.Kind != "update" && e.Kind != "zurueck" {
			continue
		}
		v := eventView{Kind: e.Kind, Text: e.Text, When: when(e.Unix),
			ISO: time.Unix(e.Unix, 0).UTC().Format(time.RFC3339), Title: e.Title, Source: e.Source}
		switch e.Kind {
		case "neu":
			v.What = e.Version + " neu im Feed"
		case "update":
			if e.From != "" {
				v.What = e.From + " → " + e.Version
			} else {
				v.What = e.Version + " geändert"
			}
		case "zurueck":
			v.What = e.Version + " zurückgezogen"
		}
		out = append(out, v)
	}
	return out
}

func (h *hub) sourcesLocked(now time.Time) []sourceView {
	out := make([]sourceView, len(h.st.Sources))
	for i, s := range h.st.Sources {
		v := sourceView{ID: s.ID, Name: s.Name, URL: s.URL, Count: len(s.Entries), First: i == 0,
			Last: i == len(h.st.Sources)-1}
		switch busy, isBusy := h.busy[s.ID]; {
		case isBusy:
			v.State, v.StateText = "busy", busy+" …"
		case s.Error != "":
			v.State = "err"
			v.StateText = fmt.Sprintf("Fehler %s: %s. Im Feed bleiben die zuletzt geladenen Pakete.",
				ago(now, s.ErrorSince), s.Error)
		case s.OK > 0:
			v.State, v.StateText = "ok", "geprüft "+ago(now, s.Checked)
		default:
			v.State, v.StateText = "new", "noch nicht abgerufen"
		}
		for _, k := range s.Skipped {
			note := fmt.Sprintf("%s %s nicht übernommen: %s.", k.ID, k.Version, k.Reason)
			if old, ok := s.Entries[k.ID]; ok {
				note += " Im Feed bleibt " + parse(old).Version + "."
			}
			v.Notes = append(v.Notes, note)
		}
		for _, id := range slices.Sorted(maps.Keys(s.Entries)) {
			if p := h.st.Published[id]; p != nil && p.Source != s.ID {
				if winner := h.sourceLocked(p.Source); winner != nil {
					v.Notes = append(v.Notes, fmt.Sprintf("%s kommt aus %s, die weiter oben steht.",
						parse(s.Entries[id]).label(), winner.Name))
				}
			}
		}
		out[i] = v
	}
	return out
}

type publicView struct {
	Name, FeedURL, Generated string
	Active                   int
	Packages, Withdrawn      []packageView
	Events                   []eventView
	Sources                  []sourceView
}

func (w *web) publicPage(rw http.ResponseWriter, r *http.Request) {
	w.stats.view(r)
	now := w.h.now()
	w.h.mu.Lock()
	v := publicView{Name: w.h.st.Name, FeedURL: w.feedURL(), Generated: ago(now, w.h.st.Generated),
		Events: w.h.eventsLocked(true, 40), Sources: w.h.sourcesLocked(now)}
	for _, p := range w.h.packagesLocked(now) {
		if p.Withdrawn {
			v.Withdrawn = append(v.Withdrawn, p)
		} else {
			v.Packages = append(v.Packages, p)
		}
	}
	w.h.mu.Unlock()
	v.Active = len(v.Packages)
	rw.Header().Set("Cache-Control", "no-cache")
	w.render(rw, http.StatusOK, "public.html", v)
}

// ---------------------------------------------------------------- admin

func (w *web) private(next func(http.ResponseWriter, *http.Request, session)) http.HandlerFunc {
	return func(rw http.ResponseWriter, r *http.Request) {
		s, ok := w.a.session(r)
		if !ok {
			if r.Method == http.MethodGet {
				http.Redirect(rw, r, "/admin/anmelden", http.StatusSeeOther)
				return
			}
			w.render(rw, http.StatusUnauthorized, "login.html", loginView{Msg: "Bitte zuerst anmelden.", Err: true})
			return
		}
		if r.Method == http.MethodPost {
			r.Body = http.MaxBytesReader(rw, r.Body, maxFormBytes)
			if err := r.ParseForm(); err != nil || !sameOrigin(r) || !w.a.checkCSRF(s, r.PostFormValue("csrf")) {
				w.h.logf("fremde-herkunft %s %s", masked(clientIP(r)), r.URL.Path)
				http.Error(rw, "Das hat nicht geklappt. Bitte die Seite neu laden und noch einmal versuchen.", http.StatusForbidden)
				return
			}
		}
		next(rw, r, s)
	}
}

type adminView struct {
	User, CSRF, Page, FeedURL, Name, Version string
	Flash                                    string
	FlashErr                                 bool
	AddValue                                 string
	Busy                                     bool
	Active, Withdrawn                        int
	Generated, Next                          string
	Sources                                  []sourceView
	Packages                                 []packageView
	Events                                   []eventView
	Stats                                    *statsView
}

var flashes = map[string]string{
	"hinzugefuegt":  "Quelle hinzugefügt. Ihre Archive werden jetzt geladen, danach stehen die Pakete im Feed.",
	"entfernt":      "Quelle entfernt. Ihre Pakete bleiben als zurückgezogen im Feed, so lehnt CoilShift ihn nicht ab.",
	"aktualisieren": "Alle Quellen werden jetzt abgerufen.",
	"name":          "Name gespeichert. Das Auto zeigt ihn nach seinem nächsten Abruf.",
	"verschoben":    "Reihenfolge geändert.",
}

func (w *web) adminView(s session, page string) adminView {
	now := w.h.now()
	w.h.mu.Lock()
	defer w.h.mu.Unlock()
	v := adminView{User: s.user, CSRF: w.a.csrf(s), Page: page, FeedURL: w.feedURL(), Name: w.h.st.Name,
		Version: version, Busy: len(w.h.busy) > 0, Generated: ago(now, w.h.st.Generated),
		Sources: w.h.sourcesLocked(now), Packages: w.h.packagesLocked(now), Events: w.h.eventsLocked(false, 80)}
	if !w.h.next.IsZero() && w.h.next.After(now) {
		v.Next = fmt.Sprintf("in %d Min.", int(w.h.next.Sub(now).Minutes())+1)
	}
	for _, p := range v.Packages {
		if p.Withdrawn {
			v.Withdrawn++
		} else {
			v.Active++
		}
	}
	return v
}

func (w *web) overview(rw http.ResponseWriter, r *http.Request, s session) {
	v := w.adminView(s, "uebersicht")
	v.Flash = flashes[r.URL.Query().Get("ok")]
	w.render(rw, http.StatusOK, "admin.html", v)
}

func (w *web) status(rw http.ResponseWriter, r *http.Request, _ session) {
	w.h.mu.Lock()
	b, _ := json.Marshal(map[string]any{"busy": w.h.busy, "stamp": w.h.stamp})
	w.h.mu.Unlock()
	rw.Header().Set("Content-Type", "application/json")
	rw.Header().Set("Cache-Control", "no-store")
	_, _ = rw.Write(b)
}

func (w *web) addSource(rw http.ResponseWriter, r *http.Request, s session) {
	input := r.PostFormValue("url")
	if _, err := w.h.add(r.Context(), input); err != nil {
		v := w.adminView(s, "uebersicht")
		v.Flash, v.FlashErr, v.AddValue = err.Error(), true, input
		w.render(rw, http.StatusUnprocessableEntity, "admin.html", v)
		return
	}
	http.Redirect(rw, r, "/admin?ok=hinzugefuegt#quellen", http.StatusSeeOther)
}

func (w *web) sourceAction(rw http.ResponseWriter, r *http.Request, s session) {
	id := r.PathValue("id")
	var err error
	ok := "verschoben"
	switch r.PathValue("aktion") {
	case "entfernen":
		_, err = w.h.remove(id)
		ok = "entfernt"
	case "hoch":
		err = w.h.move(id, -1)
	case "runter":
		err = w.h.move(id, 1)
	default:
		http.NotFound(rw, r)
		return
	}
	if err != nil {
		v := w.adminView(s, "uebersicht")
		v.Flash, v.FlashErr = err.Error(), true
		w.render(rw, http.StatusUnprocessableEntity, "admin.html", v)
		return
	}
	http.Redirect(rw, r, "/admin?ok="+ok+"#quellen", http.StatusSeeOther)
}

func (w *web) refreshNow(rw http.ResponseWriter, r *http.Request, _ session) {
	w.h.trigger()
	http.Redirect(rw, r, "/admin?ok=aktualisieren", http.StatusSeeOther)
}

func (w *web) rename(rw http.ResponseWriter, r *http.Request, s session) {
	if err := w.h.rename(r.PostFormValue("name")); err != nil {
		v := w.adminView(s, "uebersicht")
		v.Flash, v.FlashErr = err.Error(), true
		w.render(rw, http.StatusUnprocessableEntity, "admin.html", v)
		return
	}
	http.Redirect(rw, r, "/admin?ok=name#name", http.StatusSeeOther)
}

// ---------------------------------------------------------------- login

type loginView struct {
	User, Msg string
	Err, Keep bool
}

func (w *web) loginForm(rw http.ResponseWriter, r *http.Request) {
	if _, ok := w.a.session(r); ok {
		http.Redirect(rw, r, "/admin", http.StatusSeeOther)
		return
	}
	v := loginView{Keep: true}
	if r.URL.Query().Has("abgemeldet") {
		v.Msg = "Du bist abgemeldet."
	}
	w.render(rw, http.StatusOK, "login.html", v)
}

func (w *web) login(rw http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(rw, r.Body, maxFormBytes)
	if err := r.ParseForm(); err != nil || !sameOrigin(r) {
		w.h.logf("fremde-herkunft %s /admin/anmelden", masked(clientIP(r)))
		w.render(rw, http.StatusBadRequest, "login.html",
			loginView{Msg: "Das hat nicht geklappt. Bitte die Seite neu laden und noch einmal versuchen.", Err: true})
		return
	}
	name := r.PostFormValue("benutzer")
	if len(name) > 64 {
		name = name[:64]
	}
	pw := r.PostFormValue("passwort")
	if len(pw) > 256 {
		pw = pw[:256]
	}
	keep := r.PostFormValue("bleiben") == "1"
	user, wait, err := w.a.login(clientIP(r), name, pw)
	switch {
	case wait > 0:
		mins := int(wait.Minutes()) + 1
		rw.Header().Set("Retry-After", strconv.Itoa(int(wait.Seconds())+1))
		msg := fmt.Sprintf("Zu viele Fehlversuche. Bitte in %d Minuten noch einmal versuchen.", mins)
		if mins == 1 {
			msg = "Zu viele Fehlversuche. Bitte in einer Minute noch einmal versuchen."
		}
		w.render(rw, http.StatusTooManyRequests, "login.html", loginView{User: name, Msg: msg, Err: true, Keep: keep})
		return
	case err != nil:
		w.render(rw, http.StatusUnauthorized, "login.html", loginView{User: name, Msg: err.Error(), Err: true, Keep: keep})
		return
	}
	life := shortLife
	if keep {
		life = longLife
	}
	c := &http.Cookie{Name: cookieName, Value: w.a.token(user, life), Path: "/", Secure: true, HttpOnly: true,
		SameSite: http.SameSiteLaxMode}
	if keep {
		c.MaxAge = int(longLife.Seconds())
	}
	http.SetCookie(rw, c)
	http.Redirect(rw, r, "/admin", http.StatusSeeOther)
}

func (w *web) logout(rw http.ResponseWriter, r *http.Request, s session) {
	w.h.logf("abgemeldet %s %s", masked(clientIP(r)), s.user)
	http.SetCookie(rw, &http.Cookie{Name: cookieName, Value: "", Path: "/", Secure: true, HttpOnly: true,
		SameSite: http.SameSiteLaxMode, MaxAge: -1})
	http.Redirect(rw, r, "/admin/anmelden?abgemeldet=1", http.StatusSeeOther)
}

// ---------------------------------------------------------------- statistics

type column struct {
	Label, Tip, Height string
	Value              int
	Today              bool
}

type statsView struct {
	Today, Yesterday    dayView
	Avg7                string
	Downloads30         int
	Views30, Visitors30 int
	Top                 int
	Ticks               []int
	Columns             []column
	Days                []dayView
	Clients, Packages   []labelled
	HasData             bool
}

type labelled struct {
	count
	Width string
}

// niceTop rounds up to a top with four clean steps (1, 2, 5 × 10ⁿ each).
func niceTop(v int) int {
	for mag := 1; ; mag *= 10 {
		for _, b := range []int{1, 2, 5} {
			if step := b * mag; step*4 >= v {
				return step * 4
			}
		}
	}
}

func labels(cs []count) []labelled {
	out := make([]labelled, len(cs))
	for i, c := range cs {
		out[i] = labelled{count: c, Width: "w" + strconv.Itoa(max(1, int(c.Share*100+0.5)))}
	}
	return out
}

// statistics shows what can be measured: CoilShift's servers fetch the index
// and the archives for the cars, so there is no count of cars.
func (w *web) statistics(rw http.ResponseWriter, r *http.Request, s session) {
	v := w.adminView(s, "statistik")
	days := w.stats.days(30)
	sv := &statsView{Today: days[len(days)-1], Yesterday: days[len(days)-2], Days: slices.Clone(days)}
	slices.Reverse(sv.Days)
	sum7, most := 0, 0
	for i, d := range days {
		if i >= len(days)-7 {
			sum7 += d.Fetches
		}
		most = max(most, d.Fetches)
		sv.Downloads30 += d.DownloadCount()
		sv.Views30 += d.Views
		sv.Visitors30 += d.Visitors
		if d.Fetches > 0 || d.Views > 0 || len(d.Downloads) > 0 {
			sv.HasData = true
		}
	}
	sv.Avg7 = strings.Replace(strconv.FormatFloat(float64(sum7)/7, 'f', 1, 64), ".", ",", 1)
	sv.Top = niceTop(most)
	for i := 4; i >= 0; i-- {
		sv.Ticks = append(sv.Ticks, sv.Top*i/4)
	}
	for i, d := range days {
		c := column{Value: d.Fetches, Today: i == len(days)-1,
			Height: "h" + strconv.Itoa(d.Fetches*100/sv.Top),
			Tip: fmt.Sprintf("%s %s: %d Abrufe, %d Archiv-Downloads", weekday(d.Date), d.Date.Format("02.01."),
				d.Fetches, d.DownloadCount())}
		if (len(days)-1-i)%7 == 0 {
			c.Label = d.Date.Format("02.01.")
		}
		sv.Columns = append(sv.Columns, c)
	}
	sv.Clients = labels(ranked(days, func(d *dayStats) map[string]int { return d.Clients }, 8))
	sv.Packages = labels(ranked(days, func(d *dayStats) map[string]int { return d.Downloads }, 20))
	v.Stats = sv
	w.render(rw, http.StatusOK, "statistik.html", v)
}

func weekday(t time.Time) string {
	return [...]string{"So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"}[t.Weekday()]
}
