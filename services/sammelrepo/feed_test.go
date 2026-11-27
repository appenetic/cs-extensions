package main

import (
	"net/netip"
	"strings"
	"testing"
)

func netipParse(s string) (netip.Addr, error) { return netip.ParseAddr(s) }

func TestSetFieldKeepsOtherMembers(t *testing.T) {
	esc := "\\" + "u00e9"
	raw := []byte(`{"z":1.0,"id":"a","s":"<&>` + esc + `\/","withdrawn":false,"n":[1e3]}`)
	got, err := setField(raw, "withdrawn", []byte("true"))
	if err != nil {
		t.Fatal(err)
	}
	if want := `{"z":1.0,"id":"a","s":"<&>` + esc + `\/","withdrawn":true,"n":[1e3]}`; string(got) != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
	got, err = setField([]byte(`{"id":"a"}`), "withdrawn", []byte("true"))
	if err != nil || string(got) != `{"id":"a","withdrawn":true}` {
		t.Fatalf("new key: %s %v", got, err)
	}
	if _, err := setField([]byte(`[1]`), "x", []byte("1")); err == nil {
		t.Fatal("an array is no object")
	}
}

func TestSetArchiveURL(t *testing.T) {
	raw := []byte(`{"id":"a","archive":{"url":"https://x/y.csp","sha256":"s","bytes":1},"z":0}`)
	got, err := setArchiveURL(raw, "pool/s")
	if err != nil {
		t.Fatal(err)
	}
	if want := `{"id":"a","archive":{"url":"pool/s","sha256":"s","bytes":1},"z":0}`; string(got) != want {
		t.Fatalf("got %s", got)
	}
}

func TestCheckRejects(t *testing.T) {
	good := entryJSON("dev.test.ok", "1.0.0", "s", []byte("abc"))
	gc, _ := compact([]byte(good))
	if _, err := check(gc); err != nil {
		t.Fatalf("good entry refused: %v", err)
	}
	for name, raw := range map[string]string{
		"not an object":   `[1]`,
		"no id":           strings.Replace(good, `"id":"dev.test.ok"`, `"id":""`, 1),
		"id mismatch":     strings.Replace(good, `,"id":"dev.test.ok","version"`, `,"id":"dev.test.other","version"`, 1),
		"long summary":    entryJSON("dev.test.ok", "1.0.0", strings.Repeat("x", maxSummary+1), []byte("abc")),
		"bytes as string": strings.Replace(good, `"bytes":3`, `"bytes":"3"`, 1),
		"bad sha":         strings.Replace(good, `"sha256":"`, `"sha256":"X`, 1),
	} {
		c, err := compact([]byte(raw))
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if _, err := check(c); err == nil {
			t.Errorf("%s accepted", name)
		}
	}
	// The limit counts bytes, not characters.
	if _, err := check(mustCompact(t, entryJSON("dev.test.ok", "1.0.0", strings.Repeat("ö", 140), []byte("abc")))); err == nil {
		t.Error("280 bytes of umlauts accepted")
	}
	if _, err := check(mustCompact(t, entryJSON("dev.test.ok", "1.0.0", strings.Repeat("ö", 139), []byte("abc")))); err != nil {
		t.Errorf("278 bytes refused: %v", err)
	}
}

func mustCompact(t *testing.T, s string) []byte {
	t.Helper()
	c, err := compact([]byte(s))
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestRenderIsIndentedButCompactsBack(t *testing.T) {
	a := mustCompact(t, entryJSON("dev.test.a", "1", "s", []byte("a")))
	out, err := render("Sammel <Repo>", 42, [][]byte{a})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(out), "\n  \"packages\"") || !strings.Contains(string(out), `"Sammel <Repo>"`) {
		t.Fatalf("unexpected rendering:\n%s", out)
	}
	got := publishedEntries(t, out)["dev.test.a"]
	if string(got) != string(a) {
		t.Fatalf("entry changed:\n%s\n%s", got, a)
	}
}
