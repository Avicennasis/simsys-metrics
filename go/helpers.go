package simsysmetrics

import (
	"fmt"
	"net"
)

// OtherLabel is the value returned by SafeLabel when the input is outside
// the allow set.
const OtherLabel = "other"

// SafeLabel coerces a user-facing value into a bounded allow-list.
// Returns "other" (OtherLabel) for unknown inputs. Matches the Python
// simsys_metrics.safe_label and Node safeLabel behaviour.
//
//	ticker := SafeLabel(userInput, []string{"AAPL", "GOOG", "NVDA"})
func SafeLabel(value string, allowed []string) string {
	for _, a := range allowed {
		if a == value {
			return value
		}
	}
	return OtherLabel
}

// SafeLabelSet is the map variant of SafeLabel — O(1) lookups if the
// caller keeps an allow-set around.
func SafeLabelSet(value string, allowed map[string]struct{}) string {
	if _, ok := allowed[value]; ok {
		return value
	}
	return OtherLabel
}

// IPToSubnet24 buckets an IPv4 address into its /24 network as a label
// value (e.g. "192.0.2.0/24"). Returns "other" for IPv6 or unparseable
// inputs — callers that care about IPv6 cardinality should guard the
// label with a dedicated strategy (hash, relabel_drop, etc.).
//
// Per-IP visibility is valuable for spotting attacker / scanner
// saturation, but a raw IP label is unbounded. /24 aggregates
// same-AS IPs naturally (scanner farms tend to cluster by subnet) and
// caps cardinality to at most 16M values — still a lot, but bounded in
// a way that's tractable for Prometheus.
func IPToSubnet24(ip string) string {
	parsed := net.ParseIP(ip)
	if parsed == nil {
		return OtherLabel
	}
	v4 := parsed.To4()
	if v4 == nil {
		return OtherLabel
	}
	return fmt.Sprintf("%d.%d.%d.0/24", v4[0], v4[1], v4[2])
}
