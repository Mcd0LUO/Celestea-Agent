use std::any::{Any, TypeId};
use std::collections::HashMap;
use std::sync::Arc;
// ============================================================================
// 2. Typed events: broadcast + intercept (bail) + transform (waterfall)
// ============================================================================

/// A typed event bus with three dispatch modes.
///
/// - on / emit - observe-only broadcast: listeners are Fn(&E) -> ().
/// - bail / run_bail - intercept chain: listeners are Fn(&E) -> Option<R>;
///   they run in registration order and the first Some(r) short-circuits and is
///   returned; if every listener returns None, run_bail returns None. This
///   is the guard / short-circuit primitive for event pipelines.
/// - waterfall / run_waterfall - transform chain: listeners are Fn(&E, R) -> R;
///   they run in registration order, each transforming the value handed to the
///   next layer, starting from an initial value; the final value is returned.
///
/// The three modes live in separate TypeId-keyed maps, so a listener registered
/// in one mode never interferes with another. on/emit remain the observe-only
/// broadcast (backwards compatible).
#[derive(Default)]
pub struct EventBus {
    /// Observe-only broadcast listeners.
    subs: HashMap<TypeId, Vec<Arc<dyn Fn(&dyn Any) + Send + Sync>>>,
    /// Intercept listeners; the first Some short-circuits (bail mode).
    bailers: HashMap<TypeId, Vec<Arc<dyn Fn(&dyn Any) -> Option<Box<dyn Any + Send>> + Send + Sync>>>,
    /// Transform listeners; each maps the running value (waterfall mode).
    waterfalls: HashMap<TypeId, Vec<Arc<dyn Fn(&dyn Any, Box<dyn Any + Send>) -> Box<dyn Any + Send> + Send + Sync>>>,
}

impl EventBus {
    pub fn on<E: Any + Send + Sync>(&mut self, f: impl Fn(&E) + Send + Sync + 'static) {
        let f: Arc<dyn Fn(&dyn Any) + Send + Sync> = Arc::new(move |a| {
            if let Some(e) = a.downcast_ref::<E>() {
                f(e);
            }
        });
        self.subs.entry(TypeId::of::<E>()).or_default().push(f);
    }

    pub fn emit<E: Any + Send + Sync>(&self, event: &E) {
        if let Some(listeners) = self.subs.get(&TypeId::of::<E>()) {
            for f in listeners {
                f(event);
            }
        }
    }

    /// Register an intercept listener (bail mode). Bail listeners for an event
    /// type E should share one result type R; the first Some(r) returned in
    /// registration order short-circuits run_bail.
    pub fn bail<E: Any + Send + Sync, R: Any + Send + 'static>(
        &mut self,
        f: impl Fn(&E) -> Option<R> + Send + Sync + 'static,
    ) {
        let f: Arc<dyn Fn(&dyn Any) -> Option<Box<dyn Any + Send>> + Send + Sync> = Arc::new(move |a| {
            if let Some(e) = a.downcast_ref::<E>() {
                f(e).map(|r| Box::new(r) as Box<dyn Any + Send>)
            } else {
                None
            }
        });
        self.bailers.entry(TypeId::of::<E>()).or_default().push(f);
    }

    /// Run the intercept chain for E, returning the first Some(r) from the
    /// registered bail listeners (registration order), or None if all passed.
    pub fn run_bail<E: Any + Send + Sync, R: Any + Send + 'static>(&self, event: &E) -> Option<R> {
        if let Some(listeners) = self.bailers.get(&TypeId::of::<E>()) {
            for f in listeners {
                if let Some(r) = f(event) {
                    if let Ok(r) = r.downcast::<R>() {
                        return Some(*r);
                    }
                    // Result type mismatch for this request: treat as no-answer
                    // and keep scanning (callers must register one R per event).
                }
            }
        }
        None
    }

    /// Register a transform listener (waterfall mode). Listeners run in
    /// registration order; each maps the running value for the next layer. All
    /// waterfall listeners for an event type E should share one value type R.
    pub fn waterfall<E: Any + Send + Sync, R: Any + Send + 'static>(
        &mut self,
        f: impl Fn(&E, R) -> R + Send + Sync + 'static,
    ) {
        let f: Arc<dyn Fn(&dyn Any, Box<dyn Any + Send>) -> Box<dyn Any + Send> + Send + Sync> =
            Arc::new(move |a, v| {
                if let Some(e) = a.downcast_ref::<E>() {
                    match v.downcast::<R>() {
                        Ok(v) => Box::new(f(e, *v)) as Box<dyn Any + Send>,
                        Err(v) => v, // type mismatch: pass the value through
                    }
                } else {
                    v
                }
            });
        self.waterfalls.entry(TypeId::of::<E>()).or_default().push(f);
    }

    /// Run the transform chain for E, starting from init, returning the value
    /// after every waterfall listener has run (registration order).
    pub fn run_waterfall<E: Any + Send + Sync, R: Any + Send + 'static>(
        &self,
        event: &E,
        init: R,
    ) -> R {
        let mut value: Box<dyn Any + Send> = Box::new(init);
        if let Some(listeners) = self.waterfalls.get(&TypeId::of::<E>()) {
            for f in listeners {
                value = f(event, value);
            }
        }
        *value
            .downcast::<R>()
            .expect("EventBus::run_waterfall: all waterfall listeners for an event type must share one R")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    #[test]
    fn event_bus_delivers_only_matching_type() {
        #[derive(Debug, PartialEq)]
        struct Ping(u32);
        #[derive(Debug)]
        struct Pong;

        let mut bus = EventBus::default();
        let count = Arc::new(AtomicUsize::new(0));
        let c = count.clone();
        bus.on::<Ping>(move |e| {
            c.fetch_add(e.0 as usize, Ordering::SeqCst);
        });
        bus.emit(&Ping(3));
        bus.emit(&Ping(4));
        bus.emit(&Pong); // wrong type: must not fire the Ping listener
        assert_eq!(count.load(Ordering::SeqCst), 7);
    }
    #[test]
    fn event_bus_bail_short_circuits_in_order() {
        #[derive(Debug, PartialEq)]
        struct Req {
            path: String,
        }
        let mut bus = EventBus::default();
        let hits = Arc::new(AtomicUsize::new(0));
        let h1 = hits.clone();
        bus.bail::<Req, String>(move |e| {
            h1.fetch_add(1, Ordering::SeqCst);
            if e.path == "blocked" {
                Some("denied".to_string())
            } else {
                None
            }
        });
        let h2 = hits.clone();
        bus.bail::<Req, String>(move |_| {
            h2.fetch_add(1, Ordering::SeqCst);
            Some("fallback".to_string())
        });
        assert_eq!(
            bus.run_bail::<Req, String>(&Req { path: "blocked".into() }),
            Some("denied".into())
        );
        // first Some short-circuits: only the first listener ran
        assert_eq!(hits.load(Ordering::SeqCst), 1);
    }
    #[test]
    fn event_bus_bail_all_none_returns_none() {
        #[derive(Debug)]
        struct Ping;
        let mut bus = EventBus::default();
        bus.bail::<Ping, u64>(|_| None);
        bus.bail::<Ping, u64>(|_| None);
        assert_eq!(bus.run_bail::<Ping, u64>(&Ping), None);
    }
    #[test]
    fn event_bus_waterfall_transforms_in_order() {
        #[derive(Debug)]
        struct Ctx {
            base: i32,
        }
        let mut bus = EventBus::default();
        bus.waterfall::<Ctx, i32>(|e, v| v + e.base);
        bus.waterfall::<Ctx, i32>(|_, v| v * 2);
        bus.waterfall::<Ctx, i32>(|_, v| v + 1);
        // (0+10)=10 -> *2=20 -> +1=21 ; registration order matters
        assert_eq!(bus.run_waterfall::<Ctx, i32>(&Ctx { base: 10 }, 0), 21);
    }
    #[test]
    fn event_bus_modes_coexist_without_interference() {
        #[derive(Debug, PartialEq, Eq)]
        struct Ping(u32);
        let mut bus = EventBus::default();
        let observed = Arc::new(AtomicUsize::new(0));
        let o = observed.clone();
        bus.on::<Ping>(move |e| {
            o.fetch_add(e.0 as usize, Ordering::SeqCst);
        });
        bus.bail::<Ping, String>(|e| if e.0 == 42 { Some("blocked".into()) } else { None });
        bus.waterfall::<Ping, u64>(|e, v| v + e.0 as u64);
        // broadcast still sees every event
        bus.emit(&Ping(1));
        bus.emit(&Ping(2));
        assert_eq!(observed.load(Ordering::SeqCst), 3);
        // bail chain independent of broadcast
        assert_eq!(bus.run_bail::<Ping, String>(&Ping(42)), Some("blocked".into()));
        assert_eq!(bus.run_bail::<Ping, String>(&Ping(7)), None);
        // waterfall chain independent of broadcast
        assert_eq!(bus.run_waterfall::<Ping, u64>(&Ping(3), 100), 103);
        // broadcast unaffected by the intercept/transform registrations
        bus.emit(&Ping(4));
        assert_eq!(observed.load(Ordering::SeqCst), 7);
    }
    #[test]
    fn event_bus_modes_are_send_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<EventBus>();
    }

}
