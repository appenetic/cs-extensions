// Command cs-sammelrepo serves one CoilShift package repository that bundles
// several others: the car adds a single URL, the admin page adds sources.
//
//	cs-sammelrepo serve --public https://cs.example.org   the service (systemd: cs-sammelrepo.service)
//	cs-sammelrepo passwort NAME [--users F] [--stdin]     add a user or change a password
package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

const version = "1.0.0"

var userAgent = "cs-sammelrepo/" + version

func main() {
	log.SetFlags(0) // the journal stamps the lines
	args := os.Args[1:]
	if len(args) > 0 && args[0] == "passwort" {
		setPassword(args[1:])
		return
	}
	if len(args) > 0 && args[0] == "serve" {
		args = args[1:]
	}
	serve(args)
}

func credential(name, fallback string) string {
	if dir := os.Getenv("CREDENTIALS_DIRECTORY"); dir != "" {
		return filepath.Join(dir, name)
	}
	return fallback
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func serve(args []string) {
	fl := flag.NewFlagSet("serve", flag.ExitOnError)
	listen := fl.String("listen", "127.0.0.1:7356", "Adresse des Dienstes, nur 127.0.0.1 oder ::1")
	dir := fl.String("state", envOr("STATE_DIRECTORY", "/var/lib/cs-sammelrepo"), "Ordner für Zustand, Archive und Statistik")
	users := fl.String("users", credential("benutzer", "/srv/sammelrepo/benutzer"), "Benutzerdatei")
	public := fl.String("public", "", "öffentliche Adresse, z. B. https://cs.example.org")
	interval := fl.Duration("interval", 5*time.Minute, "Abstand zwischen zwei Abrufen der Quellen")
	_ = fl.Parse(args)

	host, _, err := net.SplitHostPort(*listen)
	if err != nil || (host != "127.0.0.1" && host != "::1") {
		log.Fatal("Nur 127.0.0.1 oder ::1: Der Server hat keine Firewall, der Dienst darf nicht von außen erreichbar sein.")
	}
	pub, err := url.Parse(*public)
	if err != nil || pub.Scheme != "https" || pub.Host == "" {
		log.Fatal("--public braucht die öffentliche https-Adresse des Sammel-Repos.")
	}
	userMap, err := loadUsers(*users)
	if err != nil || len(userMap) == 0 {
		log.Fatalf("Keine Benutzer in %s (anlegen mit: cs-sammelrepo passwort NAME)", *users)
	}
	if err := os.MkdirAll(*dir, 0o700); err != nil {
		log.Fatal(err)
	}
	key, err := loadKey(*dir)
	if err != nil {
		log.Fatal(err)
	}
	a, err := newAuth(userMap, key, log.Printf)
	if err != nil {
		log.Fatal(err)
	}
	h := newHub(*dir, pub, *interval)
	if err := h.load(); err != nil {
		log.Fatal(err)
	}
	st := newStats(*dir, log.Printf)
	w, err := newWeb(h, a, st)
	if err != nil {
		log.Fatal(err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	go h.loop(ctx)
	go func() {
		t := time.NewTicker(time.Minute)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				st.save()
			}
		}
	}()

	server := &http.Server{Addr: *listen, Handler: w.routes(), ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout: time.Minute, IdleTimeout: 150 * time.Second, MaxHeaderBytes: 32 << 10}
	go func() {
		<-ctx.Done()
		shut, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(shut)
	}()
	log.Printf("bereit auf %s für %s mit %d Benutzer(n), Version %s", *listen, pub, len(userMap), version)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
	st.save()
}

// readSecret reads one line; on a terminal without echo.
func readSecret(prompt string) (string, error) {
	fi, _ := os.Stdin.Stat()
	tty := fi != nil && fi.Mode()&os.ModeCharDevice != 0
	if tty {
		fmt.Fprint(os.Stderr, prompt)
		off := exec.Command("stty", "-echo")
		off.Stdin = os.Stdin
		_ = off.Run()
		defer func() {
			on := exec.Command("stty", "echo")
			on.Stdin = os.Stdin
			_ = on.Run()
			fmt.Fprintln(os.Stderr)
		}()
	}
	line, err := bufio.NewReader(os.Stdin).ReadString('\n')
	if err != nil && line == "" {
		return "", err
	}
	return strings.TrimRight(line, "\r\n"), nil
}

func setPassword(args []string) {
	var name string
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		name, args = args[0], args[1:]
	}
	fl := flag.NewFlagSet("passwort", flag.ExitOnError)
	users := fl.String("users", "/srv/sammelrepo/benutzer", "Benutzerdatei")
	stdin := fl.Bool("stdin", false, "Passwort aus der Standardeingabe lesen, ohne Nachfrage")
	_ = fl.Parse(args)
	if name == "" {
		name = fl.Arg(0)
	}
	name = normUser(name)
	if !userPattern.MatchString(name) {
		log.Fatal("Benutzername: nur a-z, 0-9, Punkt, Bindestrich und Unterstrich, höchstens 32 Zeichen.")
	}
	var pw string
	if *stdin {
		line, err := bufio.NewReader(os.Stdin).ReadString('\n')
		if err != nil && line == "" {
			log.Fatal("Kein Passwort auf der Standardeingabe.")
		}
		pw = strings.TrimRight(line, "\r\n")
	} else {
		first, err := readSecret("Neues Passwort für " + name + ": ")
		if err != nil {
			log.Fatal(err)
		}
		again, err := readSecret("Noch einmal: ")
		if err != nil || again != first {
			log.Fatal("Die beiden Eingaben stimmen nicht überein.")
		}
		pw = first
	}
	if len([]rune(pw)) < minPassword {
		log.Fatalf("Das Passwort braucht mindestens %d Zeichen.", minPassword)
	}
	hash, err := hashPassword(pw)
	if err != nil {
		log.Fatal(err)
	}
	var lines []string
	switch b, err := os.ReadFile(*users); {
	case err == nil:
		for _, l := range strings.Split(string(b), "\n") {
			if n, _, _ := strings.Cut(l, ":"); strings.TrimSpace(l) != "" && strings.TrimSpace(n) != name {
				lines = append(lines, l)
			}
		}
	case !errors.Is(err, fs.ErrNotExist):
		log.Fatal(err)
	}
	lines = append(lines, name+":"+hash)
	if err := writeFile(*users, []byte(strings.Join(lines, "\n")+"\n")); err != nil {
		log.Fatal(err)
	}
	_ = os.Chmod(*users, 0o600)
	fmt.Printf("Gespeichert in %s. Wirksam nach: systemctl restart cs-sammelrepo\n", *users)
}
