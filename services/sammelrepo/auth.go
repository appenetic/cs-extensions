package main

import (
	"bufio"
	"crypto/hmac"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// The login follows dachterrasse-anmeldung on the same server: signed
// cookie, password hash in the signature, failed attempts counted per
// address. PBKDF2 instead of scrypt, because Go's standard library has it.
const (
	cookieName   = "__Host-sammelrepo"
	shortLife    = 12 * time.Hour
	longLife     = 30 * 24 * time.Hour
	failWindow   = 15 * time.Minute
	maxFails     = 5
	maxFailsAll  = 200 // per hour, from all addresses together
	minPassword  = 12
	maxFormBytes = 16 << 10
)

// pbkdfRounds is OWASP's figure for PBKDF2-SHA256; tests lower it.
var pbkdfRounds = 600000

var (
	userPattern  = regexp.MustCompile(`^[a-z0-9._-]{1,32}$`)
	tokenPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{8,200}\.[A-Za-z0-9_-]{43}$`)
	b64          = base64.RawURLEncoding
)

func hashPassword(pw string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	dk, err := pbkdf2.Key(sha256.New, pw, salt, pbkdfRounds, 32)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("pbkdf2-sha256$%d$%s$%s", pbkdfRounds, b64.EncodeToString(salt), b64.EncodeToString(dk)), nil
}

func checkPassword(stored, pw string) bool {
	parts := strings.Split(stored, "$")
	if len(parts) != 4 || parts[0] != "pbkdf2-sha256" {
		return false
	}
	rounds, err := strconv.Atoi(parts[1])
	if err != nil || rounds < 100000 || rounds > 10000000 {
		return false
	}
	salt, err1 := b64.DecodeString(parts[2])
	want, err2 := b64.DecodeString(parts[3])
	if err1 != nil || err2 != nil || len(want) < 16 {
		return false
	}
	got, err := pbkdf2.Key(sha256.New, pw, salt, rounds, len(want))
	return err == nil && subtle.ConstantTimeCompare(got, want) == 1
}

func normUser(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	return strings.NewReplacer("ä", "ae", "ö", "oe", "ü", "ue", "ß", "ss").Replace(s)
}

func loadUsers(path string) (map[string]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	users := map[string]string{}
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		name, hash, ok := strings.Cut(strings.TrimSpace(sc.Text()), ":")
		if ok && userPattern.MatchString(name) && strings.HasPrefix(hash, "pbkdf2-sha256$") {
			users[name] = hash
		}
	}
	return users, sc.Err()
}

// loadKey returns the signing key, made on first start.
func loadKey(dir string) ([]byte, error) {
	path := filepath.Join(dir, "schluessel")
	if key, err := os.ReadFile(path); err == nil && len(key) == 32 {
		return key, nil
	}
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return nil, err
	}
	return key, writeFile(path, key)
}

type auth struct {
	users   map[string]string
	key     []byte
	limiter *limiter
	slots   chan struct{} // PBKDF2 checks at a time
	dummy   string        // checked for unknown names, so they are not refused faster
	now     func() time.Time
	logf    func(string, ...any)
}

func newAuth(users map[string]string, key []byte, logf func(string, ...any)) (*auth, error) {
	dummy, err := hashPassword(b64.EncodeToString(key[:12]))
	if err != nil {
		return nil, err
	}
	return &auth{users: users, key: key, limiter: newLimiter(), slots: make(chan struct{}, 2), dummy: dummy,
		now: time.Now, logf: logf}, nil
}

// sign covers the stored hash: after a password change, old cookies fail.
func (a *auth) sign(payload, stored string) []byte {
	m := hmac.New(sha256.New, a.key)
	m.Write([]byte(payload + "|" + stored))
	return m.Sum(nil)
}

func (a *auth) token(user string, life time.Duration) string {
	payload := fmt.Sprintf("1|%s|%d", user, a.now().Add(life).Unix())
	return b64.EncodeToString([]byte(payload)) + "." + b64.EncodeToString(a.sign(payload, a.users[user]))
}

func (a *auth) tokenUser(token string) string {
	if !tokenPattern.MatchString(token) {
		return ""
	}
	p64, s64, _ := strings.Cut(token, ".")
	payload, err1 := b64.DecodeString(p64)
	sig, err2 := b64.DecodeString(s64)
	if err1 != nil || err2 != nil {
		return ""
	}
	parts := strings.Split(string(payload), "|")
	if len(parts) != 3 || parts[0] != "1" {
		return ""
	}
	exp, err := strconv.ParseInt(parts[2], 10, 64)
	stored, ok := a.users[parts[1]]
	if err != nil || !ok || exp <= a.now().Unix() {
		return ""
	}
	if !hmac.Equal(a.sign(string(payload), stored), sig) {
		return ""
	}
	return parts[1]
}

type session struct {
	user  string
	token string
}

func (a *auth) session(r *http.Request) (session, bool) {
	for _, c := range r.Cookies() {
		if c.Name == cookieName {
			if user := a.tokenUser(c.Value); user != "" {
				return session{user: user, token: c.Value}, true
			}
		}
	}
	return session{}, false
}

// csrf is the form token of a session.
func (a *auth) csrf(s session) string {
	m := hmac.New(sha256.New, a.key)
	m.Write([]byte("csrf|" + s.token))
	return b64.EncodeToString(m.Sum(nil))
}

func (a *auth) checkCSRF(s session, got string) bool {
	return subtle.ConstantTimeCompare([]byte(a.csrf(s)), []byte(got)) == 1
}

// login checks a name and password; wait is set when the address has to
// pause first.
func (a *auth) login(ip, name, pw string) (user string, wait time.Duration, err error) {
	key, now := rateKey(ip), a.now()
	if wait := a.limiter.begin(key, now); wait > 0 {
		a.logf("gesperrt %s", masked(ip))
		return "", wait, nil
	}
	select {
	case a.slots <- struct{}{}:
	case <-time.After(10 * time.Second):
		return "", 0, errors.New("Gerade melden sich zu viele gleichzeitig an. Bitte gleich noch einmal versuchen.")
	}
	name = normUser(name)
	stored, known := a.users[name]
	if !known {
		stored = a.dummy
	}
	ok := checkPassword(stored, pw)
	if !ok && pw != strings.TrimSpace(pw) { // blanks from copying the password
		ok = checkPassword(stored, strings.TrimSpace(pw))
	}
	<-a.slots
	if !ok || !known {
		a.logf("falsch %s", masked(ip))
		return "", 0, errors.New("Benutzername oder Passwort stimmt nicht.")
	}
	a.limiter.success(key, now)
	a.logf("angemeldet %s %s", masked(ip), name)
	return name, 0, nil
}

// sameOrigin rejects forms sent from other sites. Browsers report the origin
// in Sec-Fetch-Site, which no page can forge; with Referrer-Policy
// no-referrer, Origin alone can read "null" for the own form too.
func sameOrigin(r *http.Request) bool {
	if site := r.Header.Get("Sec-Fetch-Site"); site != "" {
		return site == "same-origin" || site == "none"
	}
	origin := r.Header.Get("Origin")
	return origin == "" || origin == "null" || origin == "https://"+r.Host || origin == "http://"+r.Host
}

// clientIP is the address Caddy saw; the service listens on loopback only.
func clientIP(r *http.Request) string {
	if ip := strings.TrimSpace(r.Header.Get("X-Echte-IP")); ip != "" {
		return ip
	}
	if ap, err := netip.ParseAddrPort(r.RemoteAddr); err == nil {
		return ap.Addr().String()
	}
	return r.RemoteAddr
}

// rateKey counts an IPv6 /64 as one address: a connection usually gets a whole one.
func rateKey(ip string) string {
	a, err := netip.ParseAddr(ip)
	if err != nil {
		return "?"
	}
	a = a.Unmap()
	if a.Is4() {
		return a.String()
	}
	p, _ := a.Prefix(64)
	return p.String()
}

// masked shortens an address as in the Caddy logs: IPv4 /24, IPv6 /48.
func masked(ip string) string {
	a, err := netip.ParseAddr(ip)
	if err != nil {
		return "?"
	}
	a = a.Unmap()
	bits := 48
	if a.Is4() {
		bits = 24
	}
	p, _ := a.Prefix(bits)
	return p.Addr().String()
}

// limiter counts login attempts per address and overall. An attempt counts
// before the password is checked, so attempts sent at once cannot slip past;
// a successful login clears its address.
type limiter struct {
	mu  sync.Mutex
	by  map[string][]time.Time
	all []time.Time
}

func newLimiter() *limiter { return &limiter{by: map[string][]time.Time{}} }

func (l *limiter) prune(now time.Time) {
	for len(l.all) > 0 && now.Sub(l.all[0]) >= time.Hour {
		l.all = l.all[1:]
	}
	for k, q := range l.by {
		for len(q) > 0 && now.Sub(q[0]) >= failWindow {
			q = q[1:]
		}
		if len(q) == 0 {
			delete(l.by, k)
		} else {
			l.by[k] = q
		}
	}
}

func (l *limiter) begin(key string, now time.Time) time.Duration {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.prune(now)
	if q := l.by[key]; len(q) >= maxFails {
		return q[0].Add(failWindow).Sub(now)
	}
	if len(l.all) >= maxFailsAll {
		return l.all[0].Add(time.Hour).Sub(now)
	}
	l.by[key] = append(l.by[key], now)
	l.all = append(l.all, now)
	return 0
}

func (l *limiter) success(key string, now time.Time) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.by, key)
	for i, t := range l.all {
		if t.Equal(now) {
			l.all = append(l.all[:i], l.all[i+1:]...)
			break
		}
	}
}
