package main

import (
	"os"
	"testing"
	"time"
)

// Runs against a real DB-IP file: SAMMELREPO_GEO_DB=/path/dbip-city-lite.mmdb go test -run Geo
func TestGeoLookupRealDatabase(t *testing.T) {
	path := os.Getenv("SAMMELREPO_GEO_DB")
	if path == "" {
		t.Skip("SAMMELREPO_GEO_DB not set")
	}
	db, err := openMMDB(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.close()
	t.Logf("%s, %d nodes, record %d, IPv%d, built %s", db.kind, db.nodes, db.record, db.ipVersion, db.built.Format(time.DateOnly))
	g := &geo{db: db}
	for ip, cc := range map[string]string{"159.69.252.1": "DE", "2a01:4f8:c016:1d39::1": "DE", "8.8.8.8": "US",
		"80.187.100.1": "DE", "185.199.108.153": "", "::ffff:159.69.252.1": "DE"} {
		p := g.lookup(ip)
		t.Logf("%-24s → %+v", ip, p)
		if cc != "" && p.Country != cc {
			t.Errorf("%s: country %q, want %s", ip, p.Country, cc)
		}
	}
	if p := g.lookup("127.0.0.1"); p.Country != "" {
		t.Errorf("loopback has a place: %+v", p)
	}
}
