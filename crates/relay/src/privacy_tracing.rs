use tracing::{
    Event, Subscriber,
    field::{Field, Visit},
};
use tracing_subscriber::{Layer, layer::Context};

/// Drops any tracing event explicitly marked as containing user content.
pub(crate) struct PrivacySanitizerLayer;

impl<S> Layer<S> for PrivacySanitizerLayer
where
    S: Subscriber,
{
    fn event_enabled(&self, event: &Event<'_>, _ctx: Context<'_, S>) -> bool {
        !event_has_user_content(event)
    }
}

fn event_has_user_content(event: &Event<'_>) -> bool {
    let mut visitor = PrivacyVisitor::default();
    event.record(&mut visitor);
    visitor.user_content
}

#[derive(Default)]
struct PrivacyVisitor {
    user_content: bool,
}

impl PrivacyVisitor {
    fn inspect(&mut self, field: &Field, value: &str) {
        if field.name() == "privacy.level" && value == "user_content" {
            self.user_content = true;
        }
    }
}

impl Visit for PrivacyVisitor {
    fn record_str(&mut self, field: &Field, value: &str) {
        self.inspect(field, value);
    }

    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        if field.name() == "privacy.level"
            && format!("{value:?}").trim_matches('"') == "user_content"
        {
            self.user_content = true;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::PrivacySanitizerLayer;
    use std::sync::{Arc, Mutex};
    use tracing::{Event, Subscriber, subscriber::with_default};
    use tracing_subscriber::{Layer, layer::Context, prelude::*, registry};

    struct CountingLayer {
        count: Arc<Mutex<usize>>,
    }

    impl<S> Layer<S> for CountingLayer
    where
        S: Subscriber,
    {
        fn on_event(&self, _event: &Event<'_>, _ctx: Context<'_, S>) {
            *self.count.lock().expect("count lock poisoned") += 1;
        }
    }

    #[test]
    fn drops_events_marked_as_user_content() {
        let count = Arc::new(Mutex::new(0));
        let subscriber = registry()
            .with(CountingLayer {
                count: Arc::clone(&count),
            })
            .with(PrivacySanitizerLayer);

        with_default(subscriber, || {
            tracing::info!(privacy.level = "user_content", "contains terminal bytes");
        });

        assert_eq!(*count.lock().expect("count lock poisoned"), 0);
    }

    #[test]
    fn allows_unmarked_events() {
        let count = Arc::new(Mutex::new(0));
        let subscriber = registry()
            .with(CountingLayer {
                count: Arc::clone(&count),
            })
            .with(PrivacySanitizerLayer);

        with_default(subscriber, || {
            tracing::info!("aggregate status changed");
        });

        assert_eq!(*count.lock().expect("count lock poisoned"), 1);
    }
}
