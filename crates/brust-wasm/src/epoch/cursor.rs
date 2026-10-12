//! The pull-broadcast cursor (cache adapters spec §4.2.5, the epoch-hook draft's rules): one per
//! isolate, polled at most once per `interval_ms`, single-flight. Pure (host-tested); `sync.rs`
//! drives it against the adapter's `since(seq)`.
use brust_core::config::InvalidateArgs;
use serde::Deserialize;

/// A poll's answer cap: more events than this in one answer clears instead of replaying.
pub const MAX_REPLAY: usize = 4096;
/// The poll's own budget (the request waits at most this long for it).
pub const POLL_TIMEOUT_MS: u64 = 500;
/// JS numbers are exact up to here; a larger seq is a broken adapter.
const MAX_SAFE: u64 = (1 << 53) - 1;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Event {
    pub seq: u64,
    pub origin: String,
    pub args: InvalidateArgs,
}

/// `EpochSince` (`@brust/core/cache-adapter` types).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct SinceResp {
    #[serde(rename = "gen")]
    pub generation: String,
    pub seq: u64,
    pub behind: bool,
    pub events: Vec<Event>,
}

/// `since`'s JSON → the answer; a missing field or a seq past 2^53 − 1 is an error (a failed poll).
pub fn parse_since(json: &str) -> Result<SinceResp, String> {
    let r: SinceResp = serde_json::from_str(json).map_err(|e| format!("since: {e}"))?;
    if r.seq > MAX_SAFE || r.events.iter().any(|e| e.seq > MAX_SAFE) {
        return Err("since: seq over 2^53 - 1".into());
    }
    Ok(r)
}

/// What a poll's answer asks the isolate to do.
#[derive(Debug, PartialEq, Eq)]
pub enum Plan {
    /// First contact: take `gen`/`seq` as the starting point, nothing to replay (tier 1 is fresh).
    Adopt,
    /// Replay these foreign events, in order (`skipped_own` of this isolate's were dropped).
    Replay {
        events: Vec<(u64, InvalidateArgs)>,
        skipped_own: u32,
    },
    /// History was lost: drop tier 1. `same_gen`: the floor moves to `seq` (entries written before
    /// it are suspect); a new generation resets the floor.
    Clear { same_gen: bool, seq: u64 },
}

#[derive(Debug)]
pub struct Cursor {
    pub origin: String,
    pub interval_ms: u64,
    pub generation: Option<String>,
    pub seq: u64,
    pub last_poll_ms: Option<u64>,
    pub in_flight: bool,
}

impl Cursor {
    pub fn new(origin: String, interval_ms: u64) -> Self {
        Cursor {
            origin,
            interval_ms,
            generation: None,
            seq: 0,
            last_poll_ms: None,
            in_flight: false,
        }
    }

    /// A poll may start now: none in flight and the interval passed (the first request always polls).
    pub fn due(&self, now_ms: u64) -> bool {
        !self.in_flight
            && self
                .last_poll_ms
                .is_none_or(|t| now_ms.saturating_sub(t) >= self.interval_ms)
    }

    /// Start a poll if one is due; the seq to ask from. Concurrent requests see `in_flight`.
    pub fn begin(&mut self, now_ms: u64) -> Option<u64> {
        if !self.due(now_ms) {
            return None;
        }
        self.in_flight = true;
        self.last_poll_ms = Some(now_ms);
        Some(self.seq)
    }

    /// A failed or timed-out poll: tier 1 is kept and the next try waits a full interval.
    pub fn fail(&mut self) {
        self.in_flight = false;
    }

    /// A poll's answer → the plan, and the cursor moves to its `gen`/`seq`.
    pub fn apply(&mut self, r: SinceResp) -> Plan {
        self.in_flight = false;
        let first = self.generation.is_none();
        let same_gen = self.generation.as_deref() == Some(r.generation.as_str());
        let from = self.seq;
        self.generation = Some(r.generation);
        if first {
            self.seq = r.seq;
            return Plan::Adopt;
        }
        let lost = !same_gen
            || r.behind
            || r.seq < from
            || r.events.len() > MAX_REPLAY
            || r.events.len() as u64 != r.seq - from
            || r.events
                .iter()
                .enumerate()
                .any(|(i, e)| e.seq != from + 1 + i as u64);
        self.seq = r.seq;
        if lost {
            return Plan::Clear {
                same_gen,
                seq: r.seq,
            };
        }
        let mut skipped_own = 0;
        let events = r
            .events
            .into_iter()
            .filter(|e| {
                let own = e.origin == self.origin;
                skipped_own += u32::from(own);
                !own
            })
            .map(|e| (e.seq, e.args))
            .collect();
        Plan::Replay {
            events,
            skipped_own,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(seq: u64, origin: &str, tag: &str) -> Event {
        Event {
            seq,
            origin: origin.into(),
            args: InvalidateArgs {
                tags: vec![tag.into()],
                ..Default::default()
            },
        }
    }

    fn resp(g: &str, seq: u64, events: Vec<Event>) -> SinceResp {
        SinceResp {
            generation: g.into(),
            seq,
            behind: false,
            events,
        }
    }

    fn adopted(seq: u64) -> Cursor {
        let mut c = Cursor::new("me".into(), 1000);
        c.begin(0);
        assert_eq!(c.apply(resp("g", seq, vec![])), Plan::Adopt);
        c
    }

    #[test]
    fn due_only_after_interval_and_never_in_flight() {
        let mut c = Cursor::new("me".into(), 1000);
        assert!(c.due(0));
        assert_eq!(c.begin(0), Some(0));
        assert!(!c.due(5000), "in flight");
        assert_eq!(c.begin(5000), None);
        c.fail();
        assert!(!c.due(999));
        assert!(c.due(1000));
    }

    #[test]
    fn first_contact_adopts_without_replay() {
        let mut c = Cursor::new("me".into(), 1000);
        c.begin(0);
        assert_eq!(c.apply(resp("g", 7, vec![ev(7, "x", "a")])), Plan::Adopt);
        assert_eq!(
            (c.generation.as_deref(), c.seq, c.in_flight),
            (Some("g"), 7, false)
        );
    }

    #[test]
    fn replays_foreign_events_in_order() {
        let mut c = adopted(3);
        c.begin(2000);
        let p = c.apply(resp("g", 5, vec![ev(4, "x", "a"), ev(5, "y", "b")]));
        let Plan::Replay {
            events,
            skipped_own,
        } = p
        else {
            panic!("{p:?}")
        };
        assert_eq!(skipped_own, 0);
        assert_eq!(
            events
                .iter()
                .map(|(s, a)| (*s, a.tags[0].as_str()))
                .collect::<Vec<_>>(),
            [(4, "a"), (5, "b")]
        );
        assert_eq!(c.seq, 5);
        c.begin(4000);
        assert_eq!(
            c.apply(resp("g", 5, vec![])),
            Plan::Replay {
                events: vec![],
                skipped_own: 0
            }
        );
    }

    #[test]
    fn skips_own_origin() {
        let mut c = adopted(0);
        c.begin(2000);
        let p = c.apply(resp("g", 2, vec![ev(1, "me", "a"), ev(2, "x", "b")]));
        assert_eq!(
            p,
            Plan::Replay {
                events: vec![(2, ev(2, "x", "b").args)],
                skipped_own: 1
            }
        );
    }

    #[test]
    fn gen_change_clears() {
        let mut c = adopted(4);
        c.begin(2000);
        assert_eq!(
            c.apply(resp("h", 1, vec![])),
            Plan::Clear {
                same_gen: false,
                seq: 1
            }
        );
        assert_eq!((c.generation.as_deref(), c.seq), (Some("h"), 1));
    }

    #[test]
    fn behind_clears() {
        let mut c = adopted(4);
        c.begin(2000);
        let mut r = resp("g", 3000, vec![]);
        r.behind = true;
        assert_eq!(
            c.apply(r),
            Plan::Clear {
                same_gen: true,
                seq: 3000
            }
        );
    }

    #[test]
    fn seq_regression_clears() {
        let mut c = adopted(9);
        c.begin(2000);
        assert_eq!(
            c.apply(resp("g", 5, vec![])),
            Plan::Clear {
                same_gen: true,
                seq: 5
            }
        );
    }

    #[test]
    fn non_contiguous_seqs_clear() {
        let mut c = adopted(3);
        c.begin(2000);
        // A jump of 3 answered with only 4 and 6.
        assert_eq!(
            c.apply(resp("g", 6, vec![ev(4, "x", "a"), ev(6, "x", "b")])),
            Plan::Clear {
                same_gen: true,
                seq: 6
            }
        );
        let mut c = adopted(3);
        c.begin(2000);
        // Right count, wrong seqs.
        assert_eq!(
            c.apply(resp("g", 5, vec![ev(5, "x", "a"), ev(4, "x", "b")])),
            Plan::Clear {
                same_gen: true,
                seq: 5
            }
        );
    }

    #[test]
    fn over_max_replay_clears() {
        let mut c = adopted(0);
        c.begin(2000);
        let n = MAX_REPLAY as u64 + 1;
        let events = (1..=n).map(|s| ev(s, "x", "a")).collect();
        assert_eq!(
            c.apply(resp("g", n, events)),
            Plan::Clear {
                same_gen: true,
                seq: n
            }
        );
    }

    #[test]
    fn failure_keeps_seq_moves_last_poll() {
        let mut c = adopted(4);
        assert_eq!(c.begin(5000), Some(4));
        c.fail();
        assert_eq!((c.seq, c.last_poll_ms, c.in_flight), (4, Some(5000), false));
        assert!(!c.due(5500));
    }

    #[test]
    fn parse_rejects_missing_fields_and_seq_over_2_53() {
        let ok = r#"{"gen":"g","seq":2,"behind":false,"events":[{"seq":2,"origin":"o","args":{"tags":["a"]}}]}"#;
        assert_eq!(parse_since(ok).unwrap().events[0].args.tags, ["a"]);
        assert!(parse_since(r#"{"gen":"g","seq":2,"events":[]}"#).is_err());
        assert!(parse_since(r#"{"seq":2,"behind":false,"events":[]}"#).is_err());
        let big = format!(
            r#"{{"gen":"g","seq":{},"behind":false,"events":[]}}"#,
            1u64 << 53
        );
        assert!(parse_since(&big).unwrap_err().contains("2^53"));
    }
}
