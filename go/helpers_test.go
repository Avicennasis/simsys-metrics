package simsysmetrics

import "testing"

func TestSafeLabel(t *testing.T) {
	allowed := []string{"AAPL", "GOOG", "NVDA"}
	cases := []struct {
		in, want string
	}{
		{"AAPL", "AAPL"},
		{"GOOG", "GOOG"},
		{"ZZZZ", "other"},
		{"", "other"},
	}
	for _, c := range cases {
		if got := SafeLabel(c.in, allowed); got != c.want {
			t.Errorf("SafeLabel(%q) = %q; want %q", c.in, got, c.want)
		}
	}
}

func TestSafeLabelSet(t *testing.T) {
	allowed := map[string]struct{}{"AAPL": {}, "GOOG": {}}
	if got := SafeLabelSet("AAPL", allowed); got != "AAPL" {
		t.Errorf("SafeLabelSet AAPL = %q", got)
	}
	if got := SafeLabelSet("MSFT", allowed); got != "other" {
		t.Errorf("SafeLabelSet MSFT = %q; want other", got)
	}
}

func TestIPToSubnet24(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"192.168.1.42", "192.168.1.0/24"},
		{"10.0.0.0", "10.0.0.0/24"},
		{"8.8.8.8", "8.8.8.0/24"},
		{"255.255.255.255", "255.255.255.0/24"},
		{"", "other"},
		{"not an ip", "other"},
		{"2001:db8::1", "other"}, // IPv6 — bucketed to "other"
	}
	for _, c := range cases {
		if got := IPToSubnet24(c.in); got != c.want {
			t.Errorf("IPToSubnet24(%q) = %q; want %q", c.in, got, c.want)
		}
	}
}
