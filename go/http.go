package simsysmetrics

// StatusBucket returns the HTTP status class string ("1xx", "2xx", ..., "5xx")
// for use as a bounded-cardinality label value.
func StatusBucket(code int) string {
	switch {
	case code >= 100 && code < 200:
		return "1xx"
	case code >= 200 && code < 300:
		return "2xx"
	case code >= 300 && code < 400:
		return "3xx"
	case code >= 400 && code < 500:
		return "4xx"
	default:
		return "5xx"
	}
}
