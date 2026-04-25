package simsysmetrics

import "testing"

func TestStatusBucket(t *testing.T) {
	tests := []struct {
		code int
		want string
	}{
		{100, "1xx"},
		{199, "1xx"},
		{200, "2xx"},
		{204, "2xx"},
		{299, "2xx"},
		{301, "3xx"},
		{399, "3xx"},
		{400, "4xx"},
		{404, "4xx"},
		{500, "5xx"},
		{599, "5xx"},
		// Out-of-range treated as 5xx.
		{99, "5xx"},
		{600, "5xx"},
		{0, "5xx"},
	}
	for _, tt := range tests {
		if got := StatusBucket(tt.code); got != tt.want {
			t.Errorf("StatusBucket(%d) = %q; want %q", tt.code, got, tt.want)
		}
	}
}
