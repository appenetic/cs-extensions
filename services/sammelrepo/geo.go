package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

// The location of a sender comes from DB-IP's free "IP to City Lite"
// database (CC BY 4.0, https://db-ip.com), read in the MaxMind DB format.
// It is looked up in memory when a sender first shows up on a day; only the
// place is counted, never the address.

var errBadDB = errors.New("Geo-Datenbank beschädigt")

type mmdb struct {
	data      []byte
	unmap     func() error
	nodes     uint32
	record    int
	ipVersion int
	treeSize  int
	v4Start   uint32
	built     time.Time
	kind      string
}

func openMMDB(path string) (*mmdb, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if fi.Size() < 1024 || fi.Size() > 1<<30 {
		return nil, errBadDB
	}
	data, err := syscall.Mmap(int(f.Fd()), 0, int(fi.Size()), syscall.PROT_READ, syscall.MAP_SHARED)
	if err != nil {
		return nil, err
	}
	m := &mmdb{data: data, unmap: func() error { return syscall.Munmap(data) }}
	if err := m.readMeta(); err != nil {
		_ = m.unmap()
		return nil, err
	}
	return m, nil
}

func (m *mmdb) close() {
	if m != nil && m.unmap != nil {
		_ = m.unmap()
	}
}

func (m *mmdb) readMeta() (err error) {
	defer func() {
		if recover() != nil {
			err = errBadDB
		}
	}()
	marker := []byte("\xab\xcd\xefMaxMind.com")
	from := max(0, len(m.data)-128<<10)
	i := bytes.LastIndex(m.data[from:], marker)
	if i < 0 {
		return errBadDB
	}
	meta, _, err := m.decode(from+i+len(marker), -1, 0)
	if err != nil {
		return err
	}
	mp, _ := meta.(map[string]any)
	nodes, _ := mp["node_count"].(uint64)
	record, _ := mp["record_size"].(uint64)
	ipv, _ := mp["ip_version"].(uint64)
	epoch, _ := mp["build_epoch"].(uint64)
	m.kind, _ = mp["database_type"].(string)
	if nodes == 0 || (record != 24 && record != 28 && record != 32) || (ipv != 4 && ipv != 6) {
		return errBadDB
	}
	m.nodes, m.record, m.ipVersion = uint32(nodes), int(record), int(ipv)
	m.treeSize = int(nodes) * int(record) / 4
	m.built = time.Unix(int64(epoch), 0)
	if m.treeSize+16 > len(m.data) {
		return errBadDB
	}
	if m.ipVersion == 6 {
		// IPv4 addresses live under ::/96.
		node := uint32(0)
		for i := 0; i < 96 && node < m.nodes; i++ {
			node = m.child(node, 0)
		}
		m.v4Start = node
	}
	return nil
}

func (m *mmdb) child(node uint32, bit int) uint32 {
	switch m.record {
	case 24:
		b := m.data[int(node)*6:][:6]
		if bit == 0 {
			return uint32(b[0])<<16 | uint32(b[1])<<8 | uint32(b[2])
		}
		return uint32(b[3])<<16 | uint32(b[4])<<8 | uint32(b[5])
	case 28:
		b := m.data[int(node)*7:][:7]
		if bit == 0 {
			return (uint32(b[3])&0xf0)<<20 | uint32(b[0])<<16 | uint32(b[1])<<8 | uint32(b[2])
		}
		return (uint32(b[3])&0x0f)<<24 | uint32(b[4])<<16 | uint32(b[5])<<8 | uint32(b[6])
	default:
		b := m.data[int(node)*8:][:8]
		if bit == 0 {
			return binary.BigEndian.Uint32(b[:4])
		}
		return binary.BigEndian.Uint32(b[4:])
	}
}

// decode reads one value of the data section format at off. base is where
// pointers count from; -1 forbids them (metadata).
func (m *mmdb) decode(off, base, depth int) (any, int, error) {
	if depth > 32 {
		return nil, 0, errBadDB
	}
	d := m.data
	ctrl := d[off]
	off++
	typ := int(ctrl >> 5)
	if typ == 1 {
		if base < 0 {
			return nil, 0, errBadDB
		}
		vvv := int(ctrl & 7)
		var p int
		switch (ctrl >> 3) & 3 {
		case 0:
			p, off = vvv<<8|int(d[off]), off+1
		case 1:
			p, off = 2048+(vvv<<16|int(d[off])<<8|int(d[off+1])), off+2
		case 2:
			p, off = 526336+(vvv<<24|int(d[off])<<16|int(d[off+1])<<8|int(d[off+2])), off+3
		default:
			p, off = int(binary.BigEndian.Uint32(d[off:off+4])), off+4
		}
		v, _, err := m.decode(base+p, base, depth+1)
		return v, off, err
	}
	if typ == 0 {
		typ = 7 + int(d[off])
		off++
	}
	size := int(ctrl & 0x1f)
	switch size {
	case 29:
		size, off = 29+int(d[off]), off+1
	case 30:
		size, off = 285+(int(d[off])<<8|int(d[off+1])), off+2
	case 31:
		size, off = 65821+(int(d[off])<<16|int(d[off+1])<<8|int(d[off+2])), off+3
	}
	switch typ {
	case 2:
		return string(d[off : off+size]), off + size, nil
	case 3:
		return math.Float64frombits(binary.BigEndian.Uint64(d[off : off+8])), off + 8, nil
	case 4:
		return d[off : off+size], off + size, nil
	case 5, 6, 9, 10:
		var u uint64
		for _, b := range d[off : off+size] {
			u = u<<8 | uint64(b)
		}
		return u, off + size, nil
	case 8:
		var u uint32
		for _, b := range d[off : off+size] {
			u = u<<8 | uint32(b)
		}
		return int64(int32(u)), off + size, nil
	case 7:
		mp := make(map[string]any, size)
		for range size {
			k, next, err := m.decode(off, base, depth+1)
			if err != nil {
				return nil, 0, err
			}
			key, ok := k.(string)
			if !ok {
				return nil, 0, errBadDB
			}
			v, next, err := m.decode(next, base, depth+1)
			if err != nil {
				return nil, 0, err
			}
			mp[key], off = v, next
		}
		return mp, off, nil
	case 11:
		arr := make([]any, size)
		for i := range arr {
			v, next, err := m.decode(off, base, depth+1)
			if err != nil {
				return nil, 0, err
			}
			arr[i], off = v, next
		}
		return arr, off, nil
	case 14:
		return size != 0, off, nil
	case 15:
		return float64(math.Float32frombits(binary.BigEndian.Uint32(d[off : off+4]))), off + 4, nil
	}
	return nil, 0, errBadDB
}

func (m *mmdb) lookup(ip netip.Addr) (rec map[string]any) {
	defer func() {
		if recover() != nil {
			rec = nil
		}
	}()
	ip = ip.Unmap()
	var bits []byte
	node := uint32(0)
	switch {
	case ip.Is4():
		b := ip.As4()
		bits = b[:]
		node = m.v4Start
	case m.ipVersion == 6:
		b := ip.As16()
		bits = b[:]
	default:
		return nil
	}
	for i := 0; i < len(bits)*8 && node < m.nodes; i++ {
		node = m.child(node, int(bits[i/8]>>(7-uint(i%8))&1))
	}
	if node <= m.nodes {
		return nil
	}
	v, _, err := m.decode(m.treeSize+int(node-m.nodes), m.treeSize+16, 0)
	if err != nil {
		return nil
	}
	rec, _ = v.(map[string]any)
	return rec
}

type place struct {
	Country     string // ISO code
	CountryName string
	Region      string
	City        string
}

func name(v any) string {
	mp, _ := v.(map[string]any)
	names, _ := mp["names"].(map[string]any)
	for _, lang := range []string{"de", "en"} {
		if s, ok := names[lang].(string); ok && s != "" {
			return s
		}
	}
	return ""
}

func placeOf(rec map[string]any) place {
	var p place
	if c, ok := rec["country"].(map[string]any); ok {
		p.Country, _ = c["iso_code"].(string)
		p.CountryName = name(c)
	}
	if subs, ok := rec["subdivisions"].([]any); ok && len(subs) > 0 {
		p.Region = name(subs[0])
	}
	p.City = name(rec["city"])
	return p
}

// geo keeps the database current: DB-IP publishes a new one every month.
type geo struct {
	dir    string
	client *http.Client
	logf   func(string, ...any)
	now    func() time.Time

	mu sync.RWMutex
	db *mmdb
}

func (g *geo) path() string { return filepath.Join(g.dir, "dbip-city-lite.mmdb") }

func (g *geo) lookup(ip string) place {
	a, err := netip.ParseAddr(ip)
	if err != nil {
		return place{}
	}
	g.mu.RLock()
	defer g.mu.RUnlock()
	if g.db == nil {
		return place{}
	}
	return placeOf(g.db.lookup(a))
}

func (g *geo) swap(db *mmdb) {
	g.mu.Lock()
	old := g.db
	g.db = db
	g.mu.Unlock()
	old.close()
}

func (g *geo) built() time.Time {
	g.mu.RLock()
	defer g.mu.RUnlock()
	if g.db == nil {
		return time.Time{}
	}
	return g.db.built
}

func (g *geo) keepFresh(ctx context.Context) {
	if err := os.MkdirAll(g.dir, 0o700); err != nil {
		g.logf("Geo-Datenbank: %v", err)
		return
	}
	if db, err := openMMDB(g.path()); err == nil {
		g.swap(db)
	}
	for {
		if g.now().Sub(g.built()) > 35*24*time.Hour {
			if err := g.update(ctx); err != nil {
				g.logf("Geo-Datenbank nicht geladen: %v", err)
			}
		}
		select {
		case <-ctx.Done():
			g.swap(nil)
			return
		case <-time.After(24 * time.Hour):
		}
	}
}

// update loads this month's database, or last month's early in a month.
func (g *geo) update(ctx context.Context) error {
	var err error
	for _, t := range []time.Time{g.now(), g.now().AddDate(0, -1, 0)} {
		u := fmt.Sprintf("https://download.db-ip.com/free/dbip-city-lite-%s.mmdb.gz", t.UTC().Format("2006-01"))
		if err = g.download(ctx, u); err == nil {
			return nil
		}
	}
	return err
}

func (g *geo) download(ctx context.Context, u string) error {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Minute)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", userAgent)
	resp, err := g.client.Do(req)
	if err != nil {
		return describe(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	zr, err := gzip.NewReader(io.LimitReader(resp.Body, 200<<20))
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(g.dir, ".tmp-")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	n, err := io.Copy(f, io.LimitReader(zr, 1<<30))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	db, err := openMMDB(f.Name())
	if err != nil {
		return err
	}
	if !strings.Contains(db.kind, "City") {
		db.close()
		return fmt.Errorf("unerwartete Datenbank %q", db.kind)
	}
	if err := os.Rename(f.Name(), g.path()); err != nil {
		db.close()
		return err
	}
	g.swap(db)
	g.logf("Geo-Datenbank %s geladen (%d MB, Stand %s)", db.kind, n>>20, db.built.UTC().Format("2006-01-02"))
	return nil
}
