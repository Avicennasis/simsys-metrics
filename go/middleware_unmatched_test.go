package simsysmetrics

import (
	"bufio"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// TestMiddlewareUnmatchedRouteCollapsesToBucket asserts that scanner traffic
// (404s, /.env, /wp-admin) and any request whose extractor returns "" all land
// in a single route="__unmatched__" bucket — never in a per-path label.
func TestMiddlewareUnmatchedRouteCollapsesToBucket(t *testing.T) {
	m := mustInstallForTest(t, "mw-unmatched")

	// Extractor returns "" for any unknown path → middleware must label as
	// __unmatched__, not as the raw URL.
	extractor := func(r *http.Request) string {
		if r.URL.Path == "/known" {
			return "/known"
		}
		return ""
	}

	handler := m.Middleware(MiddlewareOpts{Extractor: extractor})(
		http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(404)
		}),
	)
	srv := httptest.NewServer(handler)
	defer srv.Close()

	for _, path := range []string{"/wp-admin", "/.env", "/wp-login.php", "/admin/.git/config"} {
		resp, err := srv.Client().Get(srv.URL + path)
		if err != nil {
			t.Fatalf("GET %s: %v", path, err)
		}
		resp.Body.Close()
	}

	body := scrapeMetrics(t, m)
	if !strings.Contains(body, `route="__unmatched__"`) {
		t.Errorf("expected route=__unmatched__ in metrics body; got:\n%s", body)
	}
	for _, leaked := range []string{`/wp-admin`, `/.env`, `/wp-login.php`, `/admin/.git/config`} {
		if strings.Contains(body, `route="`+leaked+`"`) {
			t.Errorf("raw scanner path %q leaked as route label:\n%s", leaked, body)
		}
	}
}

// TestMiddlewareNilExtractorLabelsUnmatched confirms that omitting Extractor
// labels every request as __unmatched__ rather than the raw URL.
func TestMiddlewareNilExtractorLabelsUnmatched(t *testing.T) {
	m := mustInstallForTest(t, "mw-nilextract")

	handler := m.Middleware(MiddlewareOpts{})(
		http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(200)
		}),
	)
	srv := httptest.NewServer(handler)
	defer srv.Close()

	resp, err := srv.Client().Get(srv.URL + "/anything")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	resp.Body.Close()

	body := scrapeMetrics(t, m)
	if !strings.Contains(body, `route="__unmatched__"`) {
		t.Errorf("expected route=__unmatched__ when no extractor supplied; got:\n%s", body)
	}
	if strings.Contains(body, `route="/anything"`) {
		t.Errorf("raw URL leaked as route label without extractor:\n%s", body)
	}
}

// TestMiddlewarePreservesHijacker asserts that handlers can reach
// http.Hijacker on the wrapped writer via http.NewResponseController. This
// matters for websocket upgrades and raw-TCP protocols. Previously the
// statusRecorder dropped Hijacker silently.
func TestMiddlewarePreservesHijacker(t *testing.T) {
	m := mustInstallForTest(t, "mw-hijack")

	hijacked := make(chan bool, 1)
	handler := m.Middleware(MiddlewareOpts{
		Extractor: func(*http.Request) string { return "/upgrade" },
	})(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		// http.NewResponseController walks Unwrap() to find the underlying
		// writer's Hijacker. If the wrapper drops the interface, Hijack
		// returns http.ErrNotSupported.
		rc := http.NewResponseController(w)
		conn, _, err := rc.Hijack()
		if err != nil {
			hijacked <- false
			http.Error(w, err.Error(), 500)
			return
		}
		defer conn.Close()
		// Write a minimal HTTP/1.1 response by hand so the test client returns.
		bw := bufio.NewWriter(conn)
		_, _ = bw.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: test\r\nConnection: Upgrade\r\n\r\n")
		_ = bw.Flush()
		hijacked <- true
	}))

	srv := httptest.NewServer(handler)
	defer srv.Close()

	conn, err := net.Dial("tcp", srv.Listener.Addr().String())
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	_, _ = conn.Write([]byte("GET /upgrade HTTP/1.1\r\nHost: test\r\nUpgrade: test\r\nConnection: Upgrade\r\n\r\n"))
	// Drain a bit so the handler completes.
	buf := make([]byte, 256)
	_, _ = conn.Read(buf)

	select {
	case ok := <-hijacked:
		if !ok {
			t.Fatal("Hijack failed: middleware dropped http.Hijacker interface")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("handler never ran or never reached Hijack call within 2s")
	}
}
