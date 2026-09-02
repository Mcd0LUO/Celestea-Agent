//! Rich rendering (P1): incremental markdown, syntect code highlight, thinking
//! blocks and tool cards. Only used in interactive chat / non-json runs on a
//! TTY; --json and piped output stay plain/structured.

use std::io::Write;
use std::sync::{Arc, Mutex};

use celestea_agent_loop::{EventSink, LoopEvent};
use celestea_core::{ToolDecision, ToolOutput};
use serde_json::Value;

/// True-color / style ANSI codes used throughout the renderer.
    const RESET: &str = "\x1b[0m";
    const BOLD: &str = "\x1b[1m";
    const DIM: &str = "\x1b[2m";
    const ITALIC: &str = "\x1b[3m";
    const UNDERLINE: &str = "\x1b[4m";
    const REVERSE: &str = "\x1b[7m";
    const RED: &str = "\x1b[31m";
    const GREEN: &str = "\x1b[32m";
    const YELLOW: &str = "\x1b[33m";
    const CYAN: &str = "\x1b[36m";

    /// Shared syntect syntax set + theme. Building is expensive (a second or
    /// two), so it is created once and reused, lazily, only when rich rendering
    /// first needs to highlight a code block.
    pub(crate) struct Highlighter {
        syntaxes: syntect::parsing::SyntaxSet,
        theme: syntect::highlighting::Theme,
    }

    impl Highlighter {
        fn new() -> Self {
            let syntaxes = syntect::parsing::SyntaxSet::load_defaults_newlines();
            let mut themes = syntect::highlighting::ThemeSet::load_defaults();
            let theme = themes
                .themes
                .remove("base16-ocean.dark")
                .or_else(|| themes.themes.into_values().next())
                .expect("syntect ships default themes");
            Self { syntaxes, theme }
        }

        /// Highlight `code` with syntect, returning true-color terminal escapes.
        /// Falls back to the plain-text syntax when `lang` is unknown/absent.
        fn highlight(&self, code: &str, lang: Option<&str>) -> String {
            use syntect::easy::HighlightLines;
            use syntect::util::{as_24_bit_terminal_escaped, LinesWithEndings};
            let syntax = lang
                .and_then(|l| self.syntaxes.find_syntax_by_token(l))
                .or_else(|| self.syntaxes.find_syntax_by_extension("rs"))
                .unwrap_or_else(|| self.syntaxes.find_syntax_plain_text());
            let mut h = HighlightLines::new(syntax, &self.theme);
            let mut out = String::new();
            for line in LinesWithEndings::from(code) {
                match h.highlight_line(line, &self.syntaxes) {
                    Ok(ranges) => out.push_str(&as_24_bit_terminal_escaped(&ranges, false)),
                    Err(_) => out.push_str(line),
                }
            }
            out
        }
    }

    /// One shared Highlighter across all rich sessions (built once, lazily).
    pub(crate) fn highlighter() -> Arc<Highlighter> {
        use std::sync::OnceLock;
        static HL: OnceLock<Arc<Highlighter>> = OnceLock::new();
        HL.get_or_init(|| Arc::new(Highlighter::new())).clone()
    }

    /// Render inline markdown (bold / italic / strikethrough / inline code /
    /// links) to ANSI. Pure and unit-testable.
    fn inline_ansi(line: &str) -> String {
        use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
        let parser = Parser::new_ext(line, Options::ENABLE_STRIKETHROUGH);
        let mut out = String::new();
        for ev in parser {
            match ev {
                Event::Start(tag) => match tag {
                    Tag::Strong => out.push_str(BOLD),
                    Tag::Emphasis => out.push_str(ITALIC),
                    Tag::Strikethrough => out.push_str(DIM),
                    Tag::Link { .. } => out.push_str(UNDERLINE),
                    _ => {}
                },
                Event::End(tag) => match tag {
                    TagEnd::Strong | TagEnd::Emphasis | TagEnd::Strikethrough | TagEnd::Link => {
                        out.push_str(RESET)
                    }
                    _ => {}
                },
                Event::Text(t) => out.push_str(&t),
                Event::Code(t) => {
                    out.push_str(REVERSE);
                    out.push_str(&t);
                    out.push_str(RESET);
                }
                Event::SoftBreak | Event::HardBreak => out.push('\n'),
                _ => {}
            }
        }
        out
    }

    /// Stateful, incremental markdown renderer. Feed text chunks and it returns
    /// the ANSI for every *complete* line; a partial tail is held until
    /// `finish`. Block state (fenced code, table, pending paragraph) is tracked
    /// across lines so code blocks and table headers render correctly when
    /// streamed.
pub(crate) struct StreamingMarkdown {
        hl: Option<Arc<Highlighter>>,
        /// Open fenced code block: (language, accumulated code lines).
        code: Option<(Option<String>, Vec<String>)>,
        /// True once a table separator has been seen (following rows are data).
        in_table: bool,
        /// A buffered table-candidate line (waits to see if a separator follows).
        pending: Option<String>,
        /// Partial current line (no trailing newline yet).
        tail: String,
    }

    impl StreamingMarkdown {
        pub(crate) fn new(hl: Option<Arc<Highlighter>>) -> Self {
            Self {
                hl,
                code: None,
                in_table: false,
                pending: None,
                tail: String::new(),
            }
        }

        /// Feed a chunk; returns the ANSI for lines that completed inside it.
        pub(crate) fn feed(&mut self, chunk: &str) -> String {
            let mut out = String::new();
            self.tail.push_str(chunk);
            while let Some(pos) = self.tail.find('\n') {
                let line = self.tail[..pos].to_string();
                self.tail.drain(..pos + 1);
                self.render_line(&line, &mut out);
            }
            out
        }

        /// Flush the partial tail, the pending line and any open code block.
        pub(crate) fn finish(&mut self) -> String {
            let mut out = String::new();
            if !self.tail.is_empty() {
                let line = std::mem::take(&mut self.tail);
                self.render_line(&line, &mut out);
            }
            self.flush_pending(&mut out);
            if let Some((lang, lines)) = self.code.take() {
                out.push_str(&highlight_code(
                    &lines.join("\n"),
                    lang.as_deref(),
                    self.hl.as_deref(),
                ));
                out.push('\n');
            }
            out
        }

        fn flush_pending(&mut self, out: &mut String) {
            if let Some(p) = self.pending.take() {
                out.push_str(&table_row_ansi(&p));
                out.push('\n');
            }
        }

        fn render_line(&mut self, line: &str, out: &mut String) {
            if self.code.is_some() {
                self.code_line(line, out);
                return;
            }
            let trimmed = line.trim();
            if let Some(lang) = fence_lang(trimmed) {
                self.flush_pending(out);
                self.in_table = false;
                self.code = Some((lang, Vec::new()));
                return;
            }
            if trimmed.is_empty() {
                self.flush_pending(out);
                self.in_table = false;
                out.push('\n');
                return;
            }
            if let Some((level, rest)) = atx_heading(line) {
                self.flush_pending(out);
                self.in_table = false;
                out.push_str(&heading_ansi(level, rest));
                out.push('\n');
                return;
            }
            if is_table_separator(trimmed) {
                if let Some(p) = self.pending.take() {
                    out.push_str(&table_header_ansi(&p));
                    out.push('\n');
                } else {
                    out.push_str(&format!("{DIM}{trimmed}{RESET}\n"));
                }
                out.push_str(&format!("{DIM}{trimmed}{RESET}\n"));
                self.in_table = true;
                return;
            }
            if self.in_table && line.contains('|') {
                self.flush_pending(out);
                out.push_str(&table_row_ansi(line));
                out.push('\n');
                return;
            }
            if line.contains('|') {
                self.flush_pending(out);
                self.pending = Some(line.to_string());
                return;
            }
            self.in_table = false;
            if let Some(rest) = trimmed.strip_prefix('>') {
                self.flush_pending(out);
                out.push_str(&format!("{DIM}│ {}{RESET}\n", inline_ansi(rest)));
                return;
            }
            if let Some((marker, rest)) = ul_item(trimmed) {
                self.flush_pending(out);
                out.push_str(&format!("{BOLD}{marker}{RESET} {}\n", inline_ansi(rest)));
                return;
            }
            if let Some((num, rest)) = ol_item(trimmed) {
                self.flush_pending(out);
                out.push_str(&format!("{BOLD}{num}.{RESET} {}\n", inline_ansi(rest)));
                return;
            }
            if line.starts_with("    ") || line.starts_with('\t') {
                self.flush_pending(out);
                out.push_str(&format!("{DIM}{}{RESET}\n", line.trim()));
                return;
            }
            self.flush_pending(out);
            out.push_str(&inline_ansi(line));
            out.push('\n');
        }

        fn code_line(&mut self, line: &str, out: &mut String) {
            if is_closing_fence(line.trim()) {
                let (lang, lines) = self.code.take().unwrap();
                out.push_str(&highlight_code(
                    &lines.join("\n"),
                    lang.as_deref(),
                    self.hl.as_deref(),
                ));
                out.push('\n');
            } else if let Some((_, lines)) = self.code.as_mut() {
                lines.push(line.to_string());
            }
        }
    }

    /// Render a complete markdown document to ANSI. Pure — used by tests (the
    /// streaming `feed` API is what production callers use).
    #[cfg(test)]
    fn render_markdown_ansi(src: &str, hl: Option<&Arc<Highlighter>>) -> String {
        let mut md = StreamingMarkdown::new(hl.cloned());
        let mut out = md.feed(src);
        out.push_str(&md.finish());
        out
    }

    fn fence_lang(trimmed: &str) -> Option<Option<String>> {
        if let Some(rest) = trimmed.strip_prefix("```") {
            let lang = rest.trim();
            return Some(if lang.is_empty() { None } else { Some(lang.to_string()) });
        }
        if let Some(rest) = trimmed.strip_prefix("~~~") {
            let lang = rest.trim();
            return Some(if lang.is_empty() { None } else { Some(lang.to_string()) });
        }
        None
    }

    fn is_closing_fence(trimmed: &str) -> bool {
        let t = trimmed.trim_end();
        if let Some(rest) = t.strip_prefix("```") {
            return rest.trim().is_empty();
        }
        if let Some(rest) = t.strip_prefix("~~~") {
            return rest.trim().is_empty();
        }
        false
    }

    fn atx_heading(line: &str) -> Option<(usize, &str)> {
        let t = line.trim_start();
        let mut level = 0usize;
        for c in t.chars() {
            if c == '#' {
                level += 1;
            } else {
                break;
            }
        }
        if level == 0 || level > 6 {
            return None;
        }
        let rest = &t[level..];
        if !rest.starts_with(' ') {
            return None;
        }
        Some((level, rest.trim()))
    }

    fn heading_ansi(level: usize, rest: &str) -> String {
        let code = match level {
            1 => "\x1b[1;36m",
            2 => "\x1b[1;34m",
            _ => "\x1b[1;33m",
        };
        format!("{code}{}{RESET}", inline_ansi(rest))
    }

    fn is_table_separator(trimmed: &str) -> bool {
        trimmed.contains('-')
            && trimmed.chars().all(|c| matches!(c, '|' | '-' | ':' | ' ' | '\t'))
    }

    fn table_row_ansi(line: &str) -> String {
        let cells: Vec<&str> =
            line.split('|').map(|c| c.trim()).filter(|c| !c.is_empty()).collect();
        let mut out = String::new();
        out.push_str("│ ");
        for (i, cell) in cells.iter().enumerate() {
            if i > 0 {
                out.push_str(" │ ");
            }
            out.push_str(&inline_ansi(cell));
        }
        out.push_str(" │");
        out
    }

    fn table_header_ansi(line: &str) -> String {
        let cells: Vec<&str> =
            line.split('|').map(|c| c.trim()).filter(|c| !c.is_empty()).collect();
        let mut out = String::new();
        out.push_str("│ ");
        for (i, cell) in cells.iter().enumerate() {
            if i > 0 {
                out.push_str(" │ ");
            }
            out.push_str(&format!("{BOLD}{}{RESET}", inline_ansi(cell)));
        }
        out.push_str(" │");
        out
    }

    fn ul_item(trimmed: &str) -> Option<(&'static str, &str)> {
        for marker in ["- ", "* ", "+ "] {
            if let Some(rest) = trimmed.strip_prefix(marker) {
                return Some(("•", rest.trim()));
            }
        }
        None
    }

    fn ol_item(trimmed: &str) -> Option<(String, &str)> {
        let bytes = trimmed.as_bytes();
        let mut i = 0;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if i > 0 && bytes.get(i) == Some(&b'.') && bytes.get(i + 1) == Some(&b' ') {
            Some((trimmed[..i].to_string(), trimmed[i + 2..].trim()))
        } else {
            None
        }
    }

    fn highlight_code(code: &str, lang: Option<&str>, hl: Option<&Highlighter>) -> String {
        match hl {
            Some(hl) => hl.highlight(code, lang),
            None => {
                let mut out = String::new();
                for line in code.lines() {
                    out.push_str(&format!("{DIM}{line}{RESET}\n"));
                }
                out
            }
        }
    }

    /// A single thinking line: faint [thinking] prefix + indent (a visually
    /// collapsible-looking block; full fold/unfold is deferred).
pub(crate) fn render_thinking_line(line: &str) -> String {
        format!("{DIM}  [thinking] {line}{RESET}\n")
    }

pub(crate) fn render_tool_call_card(id: &str, name: &str, args: &Value) -> String {
        format!(
            "{CYAN}⚙ {BOLD}{name}{RESET} [{id}]{RESET} {CYAN}运行中…{RESET}\n  args: {}\n",
            args
        )
    }

pub(crate) fn render_tool_result_card(name: &str, out: &ToolOutput) -> String {
        let (status, color) = match (&out.decision, &out.error) {
            (Some(ToolDecision::Deny(reason)), _) => (format!("deny: {reason}"), YELLOW),
            (Some(ToolDecision::Ask(reason)), _) => (format!("ask: {reason}"), YELLOW),
            (_, Some(e)) => (format!("error: {e}"), RED),
            (_, None) => ("成功".to_string(), GREEN),
        };
        let body = out
            .render
            .clone()
            .or_else(|| out.value.as_ref().map(|v| v.to_string()))
            .unwrap_or_default();
        let mut s = format!(
            "{color}⚙ {BOLD}{name}{RESET} [{}]{RESET} {color}{status}{RESET}\n",
            out.call_id
        );
        for line in body.lines() {
            if !line.trim().is_empty() {
                s.push_str(&format!("  {line}\n"));
            }
        }
        s
    }

    /// Mutable state shared between the event sink (called from run_turn) and
    /// the interrupt handler (flush on cancel).
    struct RenderState {
        hl: Option<Arc<Highlighter>>,
        md: StreamingMarkdown,
        thinking_tail: String,
        tool_names: std::collections::HashMap<String, String>,
    }

    impl RenderState {
        fn new(hl: Option<Arc<Highlighter>>) -> Self {
            Self {
                hl: hl.clone(),
                md: StreamingMarkdown::new(hl),
                thinking_tail: String::new(),
                tool_names: std::collections::HashMap::new(),
            }
        }
        fn reset(&mut self) {
            self.md = StreamingMarkdown::new(self.hl.clone());
            self.thinking_tail.clear();
            self.tool_names.clear();
        }
    }

    fn write_stdout(s: &str) {
        let mut w = std::io::stdout();
        let _ = w.write_all(s.as_bytes());
        let _ = w.flush();
    }

    /// The rich rendering sink: an EventSink that styles stream events,
    /// thinking and tool cards for a terminal. Owned by Env.renderer; the sink
    /// closure is handed to DefaultAgentLoop so every LoopEvent is rendered.
    pub struct RichRenderer {
        pub sink: EventSink,
        state: Arc<Mutex<RenderState>>,
    }

    impl RichRenderer {
        pub fn new() -> Self {
            let hl = Some(highlighter());
            let state = Arc::new(Mutex::new(RenderState::new(hl)));
            let sink = {
                let state = state.clone();
                Arc::new(move |ev: LoopEvent| {
                    let mut st = state.lock().unwrap();
                    let mut out = String::new();
                    match ev {
                        LoopEvent::Thinking(delta) => {
                            st.thinking_tail.push_str(&delta);
                            while let Some(pos) = st.thinking_tail.find('\n') {
                                let line = st.thinking_tail[..pos].to_string();
                                st.thinking_tail.drain(..pos + 1);
                                out.push_str(&render_thinking_line(&line));
                            }
                        }
                        LoopEvent::Text(delta) => {
                            out.push_str(&st.md.feed(&delta));
                        }
                        LoopEvent::Done(_msg) => {
                            out.push_str(&st.md.finish());
                            if !st.thinking_tail.is_empty() {
                                let tail = std::mem::take(&mut st.thinking_tail);
                                out.push_str(&render_thinking_line(&tail));
                            }
                        }
                        LoopEvent::ToolCall { id, name, args } => {
                            st.tool_names.insert(id.clone(), name.clone());
                            out.push_str(&render_tool_call_card(&id, &name, &args));
                        }
                        LoopEvent::ToolResult(tr) => {
                            let name = st
                                .tool_names
                                .get(&tr.call_id)
                                .cloned()
                                .unwrap_or_else(|| tr.call_id.clone());
                            out.push_str(&render_tool_result_card(&name, &tr));
                        }
                    }
                    if !out.is_empty() {
                        write_stdout(&out);
                    }
                })
            };
            Self { sink, state }
        }

        /// Flush buffered partial output (used on interrupt so partial output
        /// is kept before printing the interrupt status).
        pub fn flush(&self) {
            let mut st = self.state.lock().unwrap();
            let mut out = st.md.finish();
            if !st.thinking_tail.is_empty() {
                let tail = std::mem::take(&mut st.thinking_tail);
                out.push_str(&render_thinking_line(&tail));
            }
            if !out.is_empty() {
                write_stdout(&out);
            }
        }

        /// Reset per-turn state before a fresh turn.
        pub fn reset(&self) {
            self.state.lock().unwrap().reset();
        }
    }

    /// Best-effort terminal hygiene after an interrupted turn: disable any raw
    /// mode left on, park the cursor at column 0 and clear from there to the
    /// end of the screen so the REPL prompt prints cleanly. The partial output
    /// above is preserved (the renderer flushed it first).
    pub fn restore_after_interrupt() {
        use crossterm::{cursor, terminal, QueueableCommand};
        let _ = terminal::disable_raw_mode();
        let mut w = std::io::stdout();
        let _ = w.queue(cursor::MoveToColumn(0));
        let _ = w.queue(terminal::Clear(terminal::ClearType::FromCursorDown));
        let _ = w.flush();
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn md_heading_renders_ansi() {
            let out = render_markdown_ansi("# Title
", None);
            assert!(out.contains("[1;36m"), "h1 bold-cyan missing: {:?}", out);
            assert!(out.contains("Title"));
            assert!(out.contains(RESET));
        }

        #[test]
        fn md_bold_italic_and_inline_code() {
            let out = render_markdown_ansi("**hi** and `code`
", None);
            assert!(out.contains(&format!("{BOLD}hi{RESET}")));
            assert!(out.contains(&format!("{REVERSE}code{RESET}")));
        }

        #[test]
        fn md_list_bullet_and_ordered() {
            let out = render_markdown_ansi("- item
1. step
", None);
            assert!(out.contains("•"));
            assert!(out.contains("1."));
        }

        #[test]
        fn md_fenced_code_plain_without_highlighter() {
            let out = render_markdown_ansi("```rs
let x = 1;
```
", None);
            assert!(out.contains("let x = 1;"));
            assert!(out.contains(DIM));
        }

        #[test]
        fn md_fenced_code_highlights_with_syntect() {
            let hl = Some(highlighter());
            let out = render_markdown_ansi("```rs
fn main() {}
```
", hl.as_ref());
            assert!(out.contains("[38;2;"), "expected syntect true-color escapes");
            // Tokens are wrapped in their own color escapes, so assert on the
            // code tokens separately rather than the contiguous source line.
            assert!(out.contains("fn"));
            assert!(out.contains("main"));
        }

        #[test]
        fn md_table_renders_header_and_rows() {
            let out = render_markdown_ansi("a | b
--- | ---
1 | 2
", None);
            assert!(out.contains("│"));
            assert!(out.contains("a"));
            assert!(out.contains("b"));
        }

        #[test]
        fn thinking_line_has_dim_prefix() {
            let out = render_thinking_line("ponder");
            assert!(out.starts_with(DIM));
            assert!(out.contains("[thinking]"));
            assert!(out.contains("ponder"));
        }

        #[test]
        fn tool_result_card_colors_status() {
            let tr = ToolOutput {
                call_id: "c1".into(),
                value: Some(serde_json::json!("ok")),
                render: Some("done".into()),
                error: None,
                decision: Some(ToolDecision::Allow),
            };
            let ok = render_tool_result_card("ls", &tr);
            assert!(ok.contains(GREEN), "success card should be green");
            let mut err = tr.clone();
            err.error = Some("boom".into());
            let e = render_tool_result_card("ls", &err);
            assert!(e.contains(RED), "error card should be red");
            let mut deny = tr.clone();
            deny.decision = Some(ToolDecision::Deny("no".into()));
            let d = render_tool_result_card("ls", &deny);
            assert!(d.contains(YELLOW), "deny card should be yellow");
        }

        #[test]
        fn streaming_feed_is_incremental_and_flushes() {
            let mut md = StreamingMarkdown::new(None);
            // A partial line is held, not emitted.
            assert_eq!(md.feed("Hello **wo"), "");
            let out = md.feed("rld**
");
            assert!(out.contains("Hello"));
            assert!(out.contains(BOLD));
            // The held tail is flushed by finish().
            md.feed("tail");
            let fin = md.finish();
            assert!(fin.contains("tail"));
        }
    }
