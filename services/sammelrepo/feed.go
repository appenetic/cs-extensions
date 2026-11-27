package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
)

const (
	// maxSummary is the longest summary CoilShift was seen to accept. Its
	// server refuses the whole index (bad_index) when one entry breaks a rule,
	// so one long summary would block every package of every source.
	maxSummary = 279
	maxArchive = 100 << 20
)

var (
	idPattern  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
	shaPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// upstreamIndex is a repository index as fetched. Package entries stay raw:
// they are published byte for byte, so manifest_sha256 and the entry hash
// CoilShift computes (sha256 of the compact entry) stay what they were.
type upstreamIndex struct {
	Schema     *int `json:"schema"`
	Repository struct {
		Name string `json:"name"`
	} `json:"repository"`
	Packages []json.RawMessage `json:"packages"`
}

// entry is what the service reads from a package entry.
type entry struct {
	ID          string          `json:"id"`
	Version     string          `json:"version"`
	Title       string          `json:"title"`
	Summary     *string         `json:"summary"`
	Withdrawn   *bool           `json:"withdrawn"`
	Manifest    json.RawMessage `json:"manifest"`
	ManifestSHA string          `json:"manifest_sha256"`
	Archive     struct {
		URL    string `json:"url"`
		SHA256 string `json:"sha256"`
		Bytes  int64  `json:"bytes"`
	} `json:"archive"`
}

func (e entry) withdrawn() bool { return e.Withdrawn != nil && *e.Withdrawn }

func (e entry) label() string {
	if e.Title != "" {
		return e.Title
	}
	return e.ID
}

func compact(raw []byte) ([]byte, error) {
	var b bytes.Buffer
	if err := json.Compact(&b, raw); err != nil {
		return nil, err
	}
	return b.Bytes(), nil
}

func sha(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

// quote encodes s as a JSON string without HTML escaping.
func quote(s string) []byte {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(s)
	return bytes.TrimSuffix(b.Bytes(), []byte("\n"))
}

// parse reads an entry without judging it.
func parse(raw []byte) entry {
	var e entry
	_ = json.Unmarshal(raw, &e)
	return e
}

// check tells whether an upstream entry may go into the feed. The messages
// are shown on the admin page.
func check(raw []byte) (entry, error) {
	var e entry
	if !bytes.HasPrefix(raw, []byte("{")) {
		return e, errors.New("Eintrag ist kein JSON-Objekt")
	}
	if err := json.Unmarshal(raw, &e); err != nil {
		return e, errors.New("Eintrag lässt sich nicht lesen")
	}
	if !idPattern.MatchString(e.ID) {
		return e, errors.New("Paket-ID fehlt oder ist ungültig")
	}
	if e.Version == "" || len(e.Version) > 64 {
		return e, errors.New("Version fehlt oder ist zu lang")
	}
	if !bytes.HasPrefix(e.Manifest, []byte("{")) {
		return e, errors.New("Manifest fehlt")
	}
	var m struct{ ID, Version, Summary string }
	if err := json.Unmarshal(e.Manifest, &m); err != nil {
		return e, errors.New("Manifest lässt sich nicht lesen")
	}
	if m.ID != e.ID || m.Version != e.Version {
		return e, errors.New("Manifest passt nicht zum Eintrag (ID oder Version)")
	}
	// The rule all known feeds follow: sha256 of the compact manifest, keys in their order.
	if mc, err := compact(e.Manifest); err != nil || sha(mc) != e.ManifestSHA {
		return e, errors.New("manifest_sha256 passt nicht zum Manifest")
	}
	if !shaPattern.MatchString(e.Archive.SHA256) {
		return e, errors.New("Prüfsumme des Archivs fehlt oder ist ungültig")
	}
	if e.Archive.Bytes <= 0 || e.Archive.Bytes > maxArchive {
		return e, fmt.Errorf("Größe des Archivs fehlt oder liegt über %d MB", maxArchive>>20)
	}
	if e.Archive.URL == "" {
		return e, errors.New("Adresse des Archivs fehlt")
	}
	summaries := []string{m.Summary}
	if e.Summary != nil {
		summaries = append(summaries, *e.Summary)
	}
	for _, s := range summaries {
		if len(s) > maxSummary {
			return e, fmt.Errorf("Zusammenfassung hat %d Bytes, CoilShift nimmt sicher nur %d an", len(s), maxSummary)
		}
	}
	return e, nil
}

// setField returns the object raw with key set to value. All other members
// keep their order and bytes; a new key goes last.
func setField(raw []byte, key string, value []byte) ([]byte, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	if t, err := dec.Token(); err != nil || t != json.Delim('{') {
		return nil, errors.New("kein JSON-Objekt")
	}
	var b bytes.Buffer
	b.WriteByte('{')
	member := func(k []byte, v []byte) {
		if b.Len() > 1 {
			b.WriteByte(',')
		}
		b.Write(k)
		b.WriteByte(':')
		b.Write(v)
	}
	set := false
	for dec.More() {
		t, err := dec.Token()
		if err != nil {
			return nil, err
		}
		k, _ := t.(string)
		var v json.RawMessage
		if err := dec.Decode(&v); err != nil {
			return nil, err
		}
		if k == key {
			v, set = value, true
		}
		member(quote(k), v)
	}
	if !set {
		member(quote(key), value)
	}
	b.WriteByte('}')
	return compact(b.Bytes())
}

// withdraw marks an entry withdrawn: CoilShift keeps offering nothing new
// from it, and the index still holds every package it ever offered.
func withdraw(raw []byte) ([]byte, error) {
	return setField(raw, "withdrawn", []byte("true"))
}

// setArchiveURL points an entry's archive at the service's own pool.
func setArchiveURL(raw []byte, u string) ([]byte, error) {
	var e struct {
		Archive json.RawMessage `json:"archive"`
	}
	if err := json.Unmarshal(raw, &e); err != nil {
		return nil, err
	}
	archive, err := setField(e.Archive, "url", quote(u))
	if err != nil {
		return nil, err
	}
	return setField(raw, "archive", archive)
}

// render builds the combined index. Entries go in as stored (compact) and
// come out indented: CoilShift compacts them again before hashing.
func render(name string, generated int64, entries [][]byte) ([]byte, error) {
	var b bytes.Buffer
	b.WriteString(`{"schema":1,"repository":{"name":`)
	b.Write(quote(name))
	b.WriteString(`},"generated_unix":`)
	b.WriteString(strconv.FormatInt(generated, 10))
	b.WriteString(`,"packages":[`)
	for i, e := range entries {
		if i > 0 {
			b.WriteByte(',')
		}
		b.Write(e)
	}
	b.WriteString("]}")
	var out bytes.Buffer
	if err := json.Indent(&out, b.Bytes(), "", "  "); err != nil {
		return nil, err
	}
	out.WriteByte('\n')
	return out.Bytes(), nil
}
