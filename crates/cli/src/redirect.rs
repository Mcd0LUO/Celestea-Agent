// ============================================================================
// Best-effort stdout redirection for clean --json output
// ============================================================================

/// Temporarily divert process stdout so the `--json` document is the only
/// thing on stdout: streaming deltas printed by the agent loop (and any
/// tracing output) land in a scratch file while the silencer is alive.
#[cfg(unix)]
pub(crate) mod stdout_redirect {
    use std::fs::File;
    use std::os::unix::io::{AsRawFd, FromRawFd};
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    unsafe extern "C" {
        fn dup(oldfd: i32) -> i32;
        fn dup2(oldfd: i32, newfd: i32) -> i32;
    }

    pub struct Silencer {
        saved: i32,
        scratch: PathBuf,
    }

    impl Silencer {
        /// Create a silencer, or None when it could not be set up (the caller
        /// then runs without silencing — best effort only).
        pub fn new() -> Option<Self> {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let scratch = std::env::temp_dir()
                .join(format!("celestea-cli-{}-{}.out", std::process::id(), nanos));
            let file = File::create(&scratch).ok()?;
            let saved = unsafe { dup(1) };
            if saved < 0 {
                let _ = std::fs::remove_file(&scratch);
                return None;
            }
            if unsafe { dup2(file.as_raw_fd(), 1) } < 0 {
                let _ = std::fs::remove_file(&scratch);
                return None;
            }
            Some(Self { saved, scratch })
        }
    }

    impl Drop for Silencer {
        fn drop(&mut self) {
            unsafe {
                let _ = dup2(self.saved, 1); // restore stdout
                let _ = File::from_raw_fd(self.saved); // close the saved fd
            }
            let _ = std::fs::remove_file(&self.scratch);
        }
    }

    pub fn silencer() -> Option<Silencer> {
        Silencer::new()
    }
}

#[cfg(not(unix))]
pub(crate) mod stdout_redirect {
    pub struct Silencer;
    pub fn silencer() -> Option<Silencer> {
        None
    }
}
