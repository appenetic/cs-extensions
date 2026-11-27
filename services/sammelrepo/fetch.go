package main

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"syscall"
	"time"
)

const maxIndex = 4 << 20

var errBlocked = errors.New("blocked address")

// Ranges a source must not reach besides loopback, private and link-local:
// the admin types the URLs, and the server has services on 127.0.0.1 and a
// Tailscale address.
var blockedNets = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("64:ff9b::/96"),
	netip.MustParsePrefix("2001:db8::/32"),
}

func publicAddr(ip netip.Addr) bool {
	ip = ip.Unmap()
	if !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
		return false
	}
	for _, p := range blockedNets {
		if p.Contains(ip) {
			return false
		}
	}
	return true
}

// newClient returns the client for sources and archives. The address check
// runs on the resolved address of every connection, redirects included, so a
// name cannot be pointed at the server itself later.
func newClient(allowPrivate bool) *http.Client {
	dialer := &net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	if !allowPrivate {
		dialer.Control = func(_, address string, _ syscall.RawConn) error {
			host, _, err := net.SplitHostPort(address)
			if err != nil {
				return err
			}
			ip, err := netip.ParseAddr(host)
			if err != nil || !publicAddr(ip) {
				return errBlocked
			}
			return nil
		}
	}
	transport := &http.Transport{
		DialContext:            dialer.DialContext,
		TLSClientConfig:        &tls.Config{MinVersion: tls.VersionTLS12},
		TLSHandshakeTimeout:    10 * time.Second,
		ResponseHeaderTimeout:  30 * time.Second,
		IdleConnTimeout:        90 * time.Second,
		MaxIdleConnsPerHost:    4,
		MaxResponseHeaderBytes: 64 << 10,
		ForceAttemptHTTP2:      true,
	}
	return &http.Client{Transport: transport, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return errors.New("zu viele Weiterleitungen")
		}
		if req.URL.Scheme != "https" && !allowPrivate {
			return errors.New("Weiterleitung ohne HTTPS")
		}
		return nil
	}}
}

// describe turns transport errors into short German text for the admin page.
func describe(err error) error {
	switch {
	case errors.Is(err, errBlocked):
		return errors.New("die Adresse liegt im eigenen oder einem privaten Netz")
	case errors.Is(err, context.DeadlineExceeded) || os.IsTimeout(err):
		return errors.New("keine Antwort (Zeitüberschreitung)")
	}
	var dns *net.DNSError
	if errors.As(err, &dns) {
		if dns.IsNotFound {
			return fmt.Errorf("den Namen %s gibt es nicht", dns.Name)
		}
		return errors.New("Namensauflösung fehlgeschlagen")
	}
	var cert *tls.CertificateVerificationError
	if errors.As(err, &cert) {
		return errors.New("das TLS-Zertifikat ist ungültig")
	}
	var ue *url.Error
	if errors.As(err, &ue) {
		return ue.Err
	}
	return err
}

type fetched struct {
	idx         upstreamIndex
	base        *url.URL // where the index came from after redirects: archive URLs resolve against it
	etag        string
	notModified bool
}

func (h *hub) fetchIndex(ctx context.Context, u *url.URL, etag string) (*fetched, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	// A fresh copy past CDN caches: GitHub Pages hands out an index up to
	// ten minutes old otherwise.
	fresh := *u
	if fresh.RawQuery != "" {
		fresh.RawQuery += "&"
	}
	fresh.RawQuery += "_=" + strconv.FormatInt(h.now().Unix(), 10)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fresh.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept", "application/json")
	if etag != "" {
		req.Header.Set("If-None-Match", etag)
	}
	resp, err := h.client.Do(req)
	if err != nil {
		return nil, describe(err)
	}
	defer resp.Body.Close()
	base := *resp.Request.URL
	base.RawQuery, base.Fragment = "", ""
	if resp.StatusCode == http.StatusNotModified && etag != "" {
		return &fetched{base: &base, etag: etag, notModified: true}, nil
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxIndex+1))
	if err != nil {
		return nil, describe(err)
	}
	if len(body) > maxIndex {
		return nil, fmt.Errorf("der Index ist größer als %d MB", maxIndex>>20)
	}
	var idx upstreamIndex
	if err := json.Unmarshal(body, &idx); err != nil {
		return nil, errors.New("das ist kein CoilShift-Index (kein lesbares JSON)")
	}
	if idx.Schema != nil && *idx.Schema != 1 {
		return nil, fmt.Errorf("das ist kein CoilShift-Index, den dieser Dienst kennt (schema %d)", *idx.Schema)
	}
	if idx.Packages == nil {
		return nil, errors.New("das ist kein CoilShift-Index (packages fehlt)")
	}
	return &fetched{idx: idx, base: &base, etag: resp.Header.Get("ETag")}, nil
}

// mirror puts an archive into the pool unless it is there already. The pool
// is content-addressed: a file is only renamed into place after its size and
// sha256 matched the entry.
func (h *hub) mirror(ctx context.Context, src *url.URL, sum string, size int64) error {
	path := filepath.Join(h.dir, "pool", sum)
	if fi, err := os.Stat(path); err == nil && fi.Size() == size {
		return nil
	}
	select {
	case h.dl <- struct{}{}:
	case <-ctx.Done():
		return ctx.Err()
	}
	defer func() { <-h.dl }()
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, src.String(), nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", userAgent)
	resp, err := h.client.Do(req)
	if err != nil {
		return describe(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	if resp.ContentLength > size {
		return fmt.Errorf("das Archiv hat %d statt %d Bytes", resp.ContentLength, size)
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".tmp-")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name()) // fails harmlessly after the rename
	hash := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, hash), io.LimitReader(resp.Body, size+1))
	if err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return describe(err)
	}
	if n != size {
		return fmt.Errorf("das Archiv hat %d statt %d Bytes", n, size)
	}
	if hex.EncodeToString(hash.Sum(nil)) != sum {
		return errors.New("die Prüfsumme des Archivs stimmt nicht")
	}
	return os.Rename(f.Name(), path)
}
