//! mod tui - fullscreen ratatui chat (W195). Reuses the rich markdown
//! renderers (StreamingMarkdown + thinking/tool card ANSI) and converts the
//! emitted ANSI into ratatui spans. Non-TTY / --json stay on the streamed-line
//! renderer.

use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use celestea_agent_loop::{DefaultAgentLoop, EventSink, LoopEvent};
use celestea_core::{AgentError, AgentLoop, ToolDecision, ToolOutput};

use crate::config::{Env, Profile};
use crate::interrupt::InterruptKind;
use crate::render::{format_profile, parse_repl_command, ReplCommand};
use crate::rich;
use crate::ExitKind;

    use crossterm::event::{self, Event as TermEvent, KeyCode, KeyModifiers};
    use ratatui::layout::{Constraint, Layout, Margin, Rect};
    use ratatui::style::{Color, Modifier, Style};
    use ratatui::text::{Line, Span, Text};
    use ratatui::widgets::{Block, Paragraph, Wrap};
    use ratatui::Frame;
    use tokio::sync::{mpsc, watch};

    /// Min redraw interval when stream events are trickling in (throttle).
    const DRAW_INTERVAL: Duration = Duration::from_millis(20);
    /// Blank pad line(s) inserted after each finished turn.
    const TURN_GAP: usize = 1;


    // ------------------------------------------------------------------------
    // Pure, unit-testable helpers
    // ------------------------------------------------------------------------

    /// Split a chunk of ANSI text (each line terminated by newline) into
    /// individual ANSI line strings (newline stripped). Pushes into the output
    /// Vec, returns how many were pushed. A tail without newline is pushed too.
    pub(crate) fn split_ansi_lines(ansi: &str, out: &mut Vec<String>) -> usize {
        let mut start = 0usize;
        let mut pushed = 0usize;
        let bytes = ansi.as_bytes();
        for i in 0..bytes.len() {
            if bytes[i] == b'\n' {
                out.push(ansi[start..i].to_string());
                pushed += 1;
                start = i + 1;
            }
        }
        if start < bytes.len() {
            out.push(ansi[start..].to_string());
            pushed += 1;
        }
        pushed
    }

    /// The buffer that accumulates one streaming assistant message. It owns the
    /// incremental markdown streamer plus the ANSI lines completed so far.
    pub(crate) struct MessageBuf {
        pub lines: Vec<String>,
        pub finished: bool,
    }

    impl MessageBuf {
        pub fn new() -> Self {
            Self { lines: Vec::new(), finished: false }
        }
        /// Feed a text delta through the rich streamer; returns how many lines
        /// completed in this chunk (0 while a line is still partial).
        pub fn push_stream(&mut self, md: &mut rich::StreamingMarkdown, delta: &str) -> usize {
            if self.finished {
                return 0;
            }
            split_ansi_lines(&md.feed(delta), &mut self.lines)
        }
        /// Flush the partial tail / open code block; returns lines appended.
        pub fn finish_stream(&mut self, md: &mut rich::StreamingMarkdown) -> usize {
            if self.finished {
                return 0;
            }
            let n = split_ansi_lines(&md.finish(), &mut self.lines);
            self.finished = true;
            n
        }
        #[allow(dead_code)] // kept for unit tests
        pub fn is_finished(&self) -> bool {
            self.finished
        }
    }

    /// A tool's live status in the right-hand status pane.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub(crate) enum ToolStatus {
        Running,
        Success,
        Error(String),
        Denied(String),
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    pub(crate) struct ToolCard {
        pub id: String,
        pub name: String,
        pub status: ToolStatus,
    }

    impl ToolCard {
        pub fn new_call(id: String, name: String) -> Self {
            Self { id, name, status: ToolStatus::Running }
        }
        /// Resolve a running card from the call's ToolOutput.
        pub fn resolve(&mut self, out: &ToolOutput) {
            match &out.decision {
                Some(ToolDecision::Deny(reason)) | Some(ToolDecision::Ask(reason)) => {
                    self.status = ToolStatus::Denied(reason.clone())
                }
                _ => match &out.error {
                    Some(e) => self.status = ToolStatus::Error(e.clone()),
                    None => self.status = ToolStatus::Success,
                },
            }
        }
    }

    /// Dispatch decision for the chat subcommand. Pure - unit tested.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub(crate) enum ChatMode {
        /// stdout is a terminal: fullscreen ratatui TUI.
        Tui,
        /// stdout not a terminal but stdin interactive: legacy rustyline REPL.
        Repl,
        /// stdin non-terminal: read all of stdin as one shot (P1 back-compat).
        OneShot,
    }

    /// Choose the chat interaction based on stdin/stdout terminal-ness.
    pub(crate) fn chat_mode(stdin_tty: bool, stdout_tty: bool) -> ChatMode {
        if !stdin_tty {
            ChatMode::OneShot
        } else if stdout_tty {
            ChatMode::Tui
        } else {
            ChatMode::Repl
        }
    }

    /// Horizontal pane split: left (conversation) vs right (tools/status).
    /// No right pane on narrow terminals. Pure - unit tested.
    pub(crate) fn split_widths(total: u16) -> (u16, u16) {
        if total < 40 {
            return (total, 0);
        }
        let left = ((total as f32) * 0.62) as u16;
        (left, total - left)
    }

    /// Pure throttle gate: redraw only if now is at least interval past the
    /// last draw (or never drawn). Unit tested.
    pub(crate) fn should_redraw(last: Option<Instant>, now: Instant, interval: Duration) -> bool {
        match last {
            None => true,
            Some(t) => now.duration_since(t) >= interval,
        }
    }


    /// Convert one rich ANSI-styled line into a ratatui Line of styled spans.
    /// Parses the SGR codes the rich module emits (bold/dim/italic/underline/
    /// reverse, 16-colour, indexed 256, true-colour). Pure - unit tested.
    fn ansi_line_to_spans(line: &str) -> Line<'static> {
        let mut spans: Vec<Span<'static>> = Vec::new();
        let mut style = Style::new();
        let mut text = String::new();
        let chars: Vec<char> = line.chars().collect();
        let mut i = 0usize;
        while i < chars.len() {
            let c = chars[i];
            if c == '' && i + 1 < chars.len() && chars[i + 1] == '[' {
                // Reached an SGR code: flush the pending text with the style it
                // was accrued under, then apply the new attributes.
                if !text.is_empty() {
                    spans.push(Span::styled(std::mem::take(&mut text), style));
                }
                let mut j = i + 2;
                while j < chars.len() && chars[j] != 'm' && chars[j] != 'n' {
                    j += 1;
                }
                if j < chars.len() && chars[j] == 'm' {
                    let seq: String = chars[i + 2..j].iter().collect();
                    style = apply_sgr(style, &seq);
                    i = j + 1;
                } else {
                    i += 1;
                }
                continue;
            }
            text.push(c);
            i += 1;
        }
        if !text.is_empty() {
            spans.push(Span::styled(text, style));
        }
        Line::from(spans)
    }

    /// Apply one SGR parameter list (digits split by ';') to a Style.
    fn apply_sgr(mut style: Style, seq: &str) -> Style {
        let params: Vec<u8> = seq
            .split(';')
            .filter_map(|p| p.trim().parse::<u8>().ok())
            .collect();
        let mut i = 0usize;
        while i < params.len() {
            match params[i] {
                0 => style = Style::new(),
                1 => style.add_modifier = style.add_modifier | Modifier::BOLD,
                2 => style.add_modifier = style.add_modifier | Modifier::DIM,
                3 => style.add_modifier = style.add_modifier | Modifier::ITALIC,
                4 => style.add_modifier = style.add_modifier | Modifier::UNDERLINED,
                7 => style.add_modifier = style.add_modifier | Modifier::REVERSED,
                30..=37 => {
                    let color = match params[i] {
                        30 => Color::Black,
                        31 => Color::Red,
                        32 => Color::Green,
                        33 => Color::Yellow,
                        34 => Color::Blue,
                        35 => Color::Magenta,
                        36 => Color::Cyan,
                        _ => Color::Gray,
                    };
                    style = style.fg(color);
                }
                38 => {
                    i += 1;
                    if i < params.len() && params[i] == 5 && i + 1 < params.len() {
                        style = style.fg(Color::Indexed(params[i + 1]));
                        i += 2;
                        continue;
                    }
                    if i < params.len() && params[i] == 2 && i + 3 < params.len() {
                        style = style.fg(Color::Rgb(params[i + 1], params[i + 2], params[i + 3]));
                        i += 4;
                        continue;
                    }
                    break;
                }
                39 => style = style.fg(Color::Reset),
                _ => {}
            }
            i += 1;
        }
        style
    }


    // ------------------------------------------------------------------------
    // Shared state: mutated by the event sink, read each frame
    // ------------------------------------------------------------------------

    pub(crate) struct TuiState {
        pub model: String,
        /// Permanent conversation lines (user / tool / thinking / finished assistant).
        pub conv: Vec<String>,
        /// Live tool cards for the right-hand status pane.
        pub tools: Vec<ToolCard>,
        pub steps: usize,
        pub running: bool,
        pub interrupted: bool,
        pub input: String,
        /// Active streaming assistant buffer + its markdown streamer.
        pub buf: MessageBuf,
        pub md: rich::StreamingMarkdown,
        /// Tail of an incomplete thinking line.
        pub thinking_tail: String,
        pub tool_names: HashMap<String, String>,
    }

    impl TuiState {
        pub fn new(model: String) -> Self {
            Self {
                model,
                conv: Vec::new(),
                tools: Vec::new(),
                steps: 0,
                running: false,
                interrupted: false,
                input: String::new(),
                buf: MessageBuf::new(),
                md: rich::StreamingMarkdown::new(None),
                thinking_tail: String::new(),
                tool_names: HashMap::new(),
            }
        }

        /// Begin a fresh turn: clear per-turn state, mark running.
        pub fn reset_turn(&mut self) {
            self.conv.push(String::from("---"));
            self.tools.clear();
            self.steps = 0;
            self.buf = MessageBuf::new();
            self.md = rich::StreamingMarkdown::new(None);
            self.thinking_tail.clear();
            self.tool_names.clear();
            self.running = true;
            self.interrupted = false;
        }

        /// Feed a thinking delta; completed lines are pushed to conv.
        pub fn push_thinking(&mut self, delta: &str) {
            self.thinking_tail.push_str(delta);
            let mut rendered = Vec::new();
            while let Some(pos) = self.thinking_tail.find('\n') {
                let line = self.thinking_tail[..pos].to_string();
                self.thinking_tail.drain(..pos + 1);
                rendered.push(rich::render_thinking_line(&line));
            }
            for r in rendered {
                split_ansi_lines(&r, &mut self.conv);
            }
        }

        /// Apply one LoopEvent into the shared state. The caller pings the
        /// redraw notifier afterwards.
        pub fn apply_event(&mut self, ev: &LoopEvent) {
            match ev {
                LoopEvent::Text(delta) => {
                    self.buf.push_stream(&mut self.md, delta);
                }
                LoopEvent::Thinking(delta) => self.push_thinking(delta),
                LoopEvent::Done(_msg) => {
                    if !self.buf.finished {
                        self.buf.finish_stream(&mut self.md);
                    }
                    if !self.thinking_tail.is_empty() {
                        let tail = std::mem::take(&mut self.thinking_tail);
                        let r = rich::render_thinking_line(&tail);
                        split_ansi_lines(&r, &mut self.conv);
                    }
                    self.conv.append(&mut self.buf.lines);
                    self.buf.finished = true;
                    self.running = false;
                }
                LoopEvent::ToolCall { id, name, args } => {
                    self.steps += 1;
                    self.tool_names.insert(id.clone(), name.clone());
                    self.tools.push(ToolCard::new_call(id.clone(), name.clone()));
                    let r = rich::render_tool_call_card(id, name, args);
                    split_ansi_lines(&r, &mut self.conv);
                }
                LoopEvent::ToolResult(out) => {
                    let name = self
                        .tool_names
                        .get(&out.call_id)
                        .cloned()
                        .unwrap_or_else(|| out.call_id.clone());
                    if let Some(card) = self.tools.iter_mut().find(|c| c.id == out.call_id) {
                        card.resolve(out);
                    }
                    let r = rich::render_tool_result_card(&name, out);
                    split_ansi_lines(&r, &mut self.conv);
                }
            }
        }
    }


    // ------------------------------------------------------------------------
    // Renderer
    // ------------------------------------------------------------------------

    /// Vertical layout: main area, one-line status bar, three-line input box.
    fn draw(frame: &mut Frame, state: &TuiState, scroll: &mut usize) {
        let area = frame.area();
        let [main, status, input] = Layout::vertical([
            Constraint::Min(0),
            Constraint::Length(1),
            Constraint::Length(3),
        ])
        .areas::<3>(area);
        let (lw, rw) = split_widths(main.width);
        let [left, right] = Layout::horizontal([Constraint::Length(lw), Constraint::Length(rw)])
            .areas::<2>(main);

        draw_conversation(frame, left, state, scroll);
        draw_tools(frame, right, state);
        draw_statusbar(frame, status, state);
        draw_inputbar(frame, input, state);
    }
    fn draw_conversation(frame: &mut Frame, area: Rect, state: &TuiState, scroll: &mut usize) {
        let mut text: Vec<Line<'static>> = Vec::new();
        for line in &state.conv {
            text.push(ansi_line_to_spans(line));
        }
        for line in &state.buf.lines {
            text.push(ansi_line_to_spans(line));
        }

        // Auto-follow the tail unless the user has scrolled up or was interrupted.
        let count = text.len();
        let inner_h = area.height.saturating_sub(2).max(1) as usize;
        let max_scroll = count.saturating_sub(inner_h);
        if !state.interrupted && *scroll == 0 && count > inner_h {
            *scroll = max_scroll;
        }
        if *scroll > max_scroll {
            *scroll = max_scroll;
        }

        let (title, title_color) = if state.running {
            ("● running", Color::Cyan)
        } else {
            ("conversation", Color::Gray)
        };
        let block = Block::bordered()
            .title(title)
            .title_style(Style::new().fg(title_color));
        let para = Paragraph::new(Text::from(text))
            .block(block)
            .wrap(Wrap { trim: false })
            .scroll((*scroll as u16, 0));
        frame.render_widget(para, area);
    }

    fn draw_tools(frame: &mut Frame, area: Rect, state: &TuiState) {
        if area.width < 4 {
            return;
        }
        let mut lines: Vec<Line<'static>> = Vec::new();
        for card in &state.tools {
            let (icon, color) = match &card.status {
                ToolStatus::Running => ("⚙", Color::Cyan),
                ToolStatus::Success => ("✓", Color::Green),
                ToolStatus::Error(_) => ("✗", Color::Red),
                ToolStatus::Denied(_) => ("⊘", Color::Yellow),
            };
            let status_txt = match &card.status {
                ToolStatus::Running => String::from("running"),
                ToolStatus::Success => String::from("ok"),
                ToolStatus::Error(e) => format!("err: {e}"),
                ToolStatus::Denied(r) => format!("deny: {r}"),
            };
            lines.push(Line::from(vec![
                Span::styled(format!("{icon} "), Style::new().fg(color)),
                Span::styled(
                    card.name.clone(),
                    Style::new().fg(Color::LightCyan).add_modifier(Modifier::BOLD),
                ),
                Span::styled(format!(" [{}]", card.id), Style::new().fg(Color::DarkGray)),
                Span::styled(status_txt, Style::new().fg(color)),
            ]));
            lines.push(Line::raw(""));
        }
        if lines.is_empty() {
            lines.push(Line::styled("no tools yet", Style::new().fg(Color::DarkGray)));
        }
        let block = Block::bordered()
            .title("tools / status")
            .title_style(Style::new().fg(Color::Gray));
        frame.render_widget(Paragraph::new(Text::from(lines)).block(block), area);
    }

    fn draw_statusbar(frame: &mut Frame, area: Rect, state: &TuiState) {
        let mut segs: Vec<Span<'static>> = vec![
            Span::styled(format!("model: {}", state.model), Style::new().fg(Color::Cyan)),
            Span::raw("   "),
            Span::styled(format!("steps: {}", state.steps), Style::new().fg(Color::Gray)),
        ];
        if state.running {
            segs.push(Span::styled("   ● streaming", Style::new().fg(Color::Cyan)));
        }
        if state.interrupted {
            segs.push(Span::styled("   ⏹ 已中断", Style::new().fg(Color::Yellow)));
        }
        frame.render_widget(
            Paragraph::new(Line::from(segs)).style(Style::new().bg(Color::DarkGray)),
            area,
        );
    }

    fn draw_inputbar(frame: &mut Frame, area: Rect, state: &TuiState) {
        let prompt = if state.running {
            " (running: Ctrl-C cancel / Ctrl-Cx2 quit) "
        } else {
            " > "
        };
        let mut segs = vec![
            Span::styled(prompt, Style::new().fg(Color::Cyan)),
            Span::styled(state.input.clone(), Style::new()),
        ];
        if state.running {
            segs.push(Span::styled(" ▌", Style::new().fg(Color::Cyan)));
        }
        let block = Block::bordered().title("input").title_style(Style::new().fg(Color::DarkGray));
        frame.render_widget(Paragraph::new(Line::from(segs)).block(block), area);
        // put the terminal cursor inside the input box after the typed text
        let inner = area.inner(Margin { horizontal: 1, vertical: 1 });
        let x = inner.x + (prompt.chars().count() + state.input.chars().count()) as u16;
        frame.set_cursor_position((x, inner.y));
    }


    // ------------------------------------------------------------------------
    // The fullscreen chat loop
    // ------------------------------------------------------------------------

    /// Build an EventSink that applies every LoopEvent into the shared state
    /// and pings the redraw notifier so the draw loop wakes up.
    fn make_sink(state: Arc<Mutex<TuiState>>, tx: mpsc::UnboundedSender<()>) -> EventSink {
        Arc::new(move |ev: LoopEvent| {
            let mut st = state.lock().unwrap();
            st.apply_event(&ev);
            let _ = tx.send(());
        })
    }

    /// Read the next terminal event asynchronously by running crossterm's
    /// blocking read on a helper thread and forwarding over a tokio mpsc.
    async fn next_term_event() -> Option<TermEvent> {
        let (tx, mut rx) = mpsc::unbounded_channel::<TermEvent>();
        std::thread::spawn(move || loop {
            match event::read() {
                Ok(ev) => {
                    if tx.send(ev).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        });
        rx.recv().await
    }

    type Backend = ratatui::backend::CrosstermBackend<std::io::Stdout>;
    type Term = ratatui::Terminal<Backend>;


    /// Run one turn in the fullscreen TUI with Ctrl-C integrated into the raw
    /// mode key stream (tokio::signal would not fire in raw mode). First Ctrl-C
    /// cancels gracefully; a second force-quits.
    async fn run_tui_turn(
        env: &Env,
        term: &mut Term,
        state: &Arc<Mutex<TuiState>>,
        input: &str,
    ) -> (Result<(), AgentError>, InterruptKind) {
        let (cancel_tx, cancel_rx) = watch::channel(false);
        {
            let mut st = state.lock().unwrap();
            st.reset_turn();
            st.conv.push(format!("You: {input}"));
        }

        let (notify_tx, mut notify_rx) = mpsc::unbounded_channel::<()>();
        let sink = make_sink(state.clone(), notify_tx);
        let agent = DefaultAgentLoop::with_cancel_sink(env.config.clone(), cancel_rx, sink);
        let turn = agent.run_turn(&env.ctx, input);
        tokio::pin!(turn);

        let mut cancelled = false;
        let mut last_draw: Option<Instant> = None;
        let mut scroll: usize = 0;

        loop {
            // Throttled live redraw so rapid tokens do not overwhelm the term.
            let now = Instant::now();
            if should_redraw(last_draw, now, DRAW_INTERVAL) {
                let st = state.lock().unwrap();
                let _ = term.draw(|f| draw(f, &st, &mut scroll));
                last_draw = Some(now);
            }

            let event = tokio::select! {
                _ = notify_rx.recv() => continue,
                ev = next_term_event() => ev,
                r = &mut turn => {
                    return if cancelled {
                        (r, InterruptKind::Cancelled)
                    } else {
                        (r, InterruptKind::None)
                    };
                }
            };

            if let Some(TermEvent::Key(k)) = event {
                let ctrl_c =
                    k.code == KeyCode::Char('c') && k.modifiers.contains(KeyModifiers::CONTROL);
                if ctrl_c {
                    if !cancelled {
                        cancelled = true;
                        let _ = cancel_tx.send(true);
                        state.lock().unwrap().interrupted = true;
                    } else {
                        // Second Ctrl-C: force-quit the fullscreen TUI.
                        state.lock().unwrap().interrupted = true;
                        let st = state.lock().unwrap();
                        let _ = term.draw(|f| draw(f, &st, &mut scroll));
                        return (Ok(()), InterruptKind::ForceQuit);
                    }
                }
            }
        }
    }


    /// Fullscreen chat REPL. Returns the ExitKind accumulated on quit.
    pub(crate) async fn run_chat_tui(env: &Env, profile: &Profile) -> ExitKind {
        let history_path = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir)
            .join(".celestea_history");
        let mut history: Vec<String> = match std::fs::read_to_string(&history_path) {
            Ok(s) => s.lines().map(|l| l.to_string()).collect(),
            Err(_) => Vec::new(),
        };
        let mut history_idx: Option<usize> = None;

        let mut term = ratatui::init();
        let state = Arc::new(Mutex::new(TuiState::new(profile.model.clone())));
        let mut code = ExitKind::Ok;

        'outer: loop {
            {
                let st = state.lock().unwrap();
                let mut scroll = 0usize;
                let _ = term.draw(|f| draw(f, &st, &mut scroll));
            }

            let ev = next_term_event().await;

            // Ctrl-D (raw-mode char 'd' + CONTROL) quits the fullscreen TUI.
            if let Some(TermEvent::Key(k)) = ev.as_ref() {
                if k.code == KeyCode::Char('d') && k.modifiers.contains(KeyModifiers::CONTROL) {
                    break 'outer;
                }
            }


            let mut submitted: Option<String> = None;
            if let Some(TermEvent::Key(k)) = ev {
                let ctrl_c =
                    k.code == KeyCode::Char('c') && k.modifiers.contains(KeyModifiers::CONTROL);
                if ctrl_c {
                    // At the prompt Ctrl-C clears the current input line.
                    let mut st = state.lock().unwrap();
                    st.input.clear();
                    continue;
                }
                match k.code {
                    KeyCode::Enter => {
                        let mut st = state.lock().unwrap();
                        submitted = Some(std::mem::take(&mut st.input));
                    }
                    KeyCode::Backspace => {
                        let mut st = state.lock().unwrap();
                        st.input.pop();
                    }
                    KeyCode::Char(c) => {
                        let mut st = state.lock().unwrap();
                        st.input.push(c);
                    }
                    KeyCode::Esc => {
                        let mut st = state.lock().unwrap();
                        st.input.clear();
                    }
                    KeyCode::Up => {
                        if !history.is_empty() {
                            let idx = history_idx.unwrap_or(history.len()).saturating_sub(1);
                            history_idx = Some(idx);
                            let mut st = state.lock().unwrap();
                            st.input = history.get(idx).cloned().unwrap_or_default();
                        }
                    }
                    KeyCode::Down => {
                        if let Some(idx) = history_idx {
                            let ni = idx + 1;
                            let mut st = state.lock().unwrap();
                            if ni < history.len() {
                                history_idx = Some(ni);
                                st.input = history[ni].clone();
                            } else {
                                history_idx = None;
                                st.input.clear();
                            }
                        }
                    }
                    _ => {}
                }
            }

            let line: String = match submitted {
                Some(s) => s.trim().to_string(),
                None => continue,
            };
            if line.is_empty() {
                continue;
            }


            if line == "exit" || line == "quit" {
                break 'outer;
            }
            if let Some(cmd) = parse_repl_command(&line) {
                match cmd {
                    ReplCommand::Exit => break 'outer,
                    ReplCommand::Clear => {
                        state.lock().unwrap().conv.clear();
                    }
                    ReplCommand::Tools => {
                        let mut st = state.lock().unwrap();
                        st.conv.push(String::from("tools:"));
                        for t in env.registry.schemas() {
                            st.conv.push(format!("  {} - {}", t.name, t.description));
                        }
                    }
                    ReplCommand::Model => {
                        let mut st = state.lock().unwrap();
                        st.conv.push(format!("model: {}", profile.model));
                    }
                    ReplCommand::Profile => {
                        let mut st = state.lock().unwrap();
                        st.conv.push(format!("profile: {}", format_profile(profile)));
                    }
                    ReplCommand::Unknown(name) => {
                        let mut st = state.lock().unwrap();
                        st.conv.push(format!("unknown /{name}"));
                    }
                }
                continue;
            }

            history.push(line.clone());
            history_idx = None;
            let (result, interrupt) = run_tui_turn(env, &mut term, &state, &line).await;
            match interrupt {
                InterruptKind::ForceQuit => {
                    code = ExitKind::Interrupted;
                    break 'outer;
                }
                InterruptKind::Cancelled => {
                    let mut st = state.lock().unwrap();
                    let mut md = std::mem::replace(&mut st.md, rich::StreamingMarkdown::new(None));
                    st.buf.finish_stream(&mut md);
                    st.md = md;
                    let done = std::mem::take(&mut st.buf.lines);
                    st.conv.extend(done);
                    st.conv.push(String::from("⏹ 已中断 (turn cancelled)"));
                    st.buf = MessageBuf::new();
                    st.running = false;
                    st.interrupted = true;
                }
                InterruptKind::None => {
                    let mut st = state.lock().unwrap();
                    if let Err(e) = result {
                        st.conv.push(format!("error: {e}"));
                        code.merge(ExitKind::Turn);
                    }
                    for _ in 0..TURN_GAP {
                        st.conv.push(String::new());
                    }
                }
            }
        }

        // Persist the history file (best effort).
        if let Ok(mut f) = std::fs::File::create(&history_path) {
            let joined = history.join("\n");
            let _ = std::io::Write::write_all(&mut f, joined.as_bytes());
        }

        ratatui::restore();
        let _ = std::io::stdout().flush();
        code
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn split_lines_keeps_empties_and_tail() {
            let mut out = Vec::new();
            let n = split_ansi_lines("a\n\nb", &mut out);
            assert_eq!(n, 3);
            assert_eq!(out, ["a", "", "b"]);
            out.clear();
            let n2 = split_ansi_lines("x\n", &mut out);
            assert_eq!(n2, 1);
            assert_eq!(out, ["x"]);
        }

        #[test]
        fn message_buf_incremental_and_finish() {
            let mut buf = MessageBuf::new();
            let mut md = rich::StreamingMarkdown::new(None);
            // A partial line is held, not emitted.
            assert_eq!(buf.push_stream(&mut md, "Hello **wo"), 0);
            assert!(buf.lines.is_empty());
            // Completion of the line (with a trailing newline) emits one line.
            let n = buf.push_stream(&mut md, "rld**\n");
            assert_eq!(n, 1);
            assert_eq!(buf.lines.len(), 1);
            // rich renders the bold markers away into ANSI.
            assert!(buf.lines[0].contains("Hello"));
            assert!(buf.lines[0].contains("[1mworld[0m"));
            assert!(!buf.is_finished());
            // A trailing partial line is flushed by finish.
            buf.push_stream(&mut md, "tail");
            let nf = buf.finish_stream(&mut md);
            assert_eq!(nf, 1);
            assert_eq!(buf.lines.len(), 2);
            assert_eq!(buf.lines[1], "tail");
            assert!(buf.is_finished());
            // No double-finish.
            assert_eq!(buf.finish_stream(&mut md), 0);
        }


        #[test]
        fn tool_card_resolve_transitions() {
            let ok = |o: ToolOutput| {
                let mut c = ToolCard::new_call("c".into(), "t".into());
                c.resolve(&o);
                c.status
            };
            assert_eq!(ok(ToolOutput { call_id: "c".into(), value: Some(serde_json::json!("x")), render: None, error: None, decision: Some(ToolDecision::Allow) }), ToolStatus::Success);
            assert_eq!(ok(ToolOutput { call_id: "c".into(), value: None, render: None, error: Some("boom".into()), decision: None }), ToolStatus::Error("boom".into()));
            assert_eq!(ok(ToolOutput { call_id: "c".into(), value: None, render: None, error: None, decision: Some(ToolDecision::Deny("no".into())) }), ToolStatus::Denied("no".into()));
        }


        #[test]
        fn chat_mode_dispatches() {
            assert_eq!(chat_mode(true, true), ChatMode::Tui);
            assert_eq!(chat_mode(true, false), ChatMode::Repl);
            assert_eq!(chat_mode(false, true), ChatMode::OneShot);
            assert_eq!(chat_mode(false, false), ChatMode::OneShot);
        }

        #[test]
        fn split_widths_reserves_right_pane_but_drops_on_narrow() {
            assert_eq!(split_widths(120), (74, 46));
            assert_eq!(split_widths(39), (39, 0));
            let (l, r) = split_widths(100);
            assert!(l > 0 && r > 0 && l + r == 100);
        }

        #[test]
        fn throttle_redraw_gate() {
            let t0 = Instant::now();
            assert!(should_redraw(None, t0, std::time::Duration::from_millis(20)));
            let soon = t0 + std::time::Duration::from_millis(5);
            assert!(!should_redraw(Some(t0), soon, std::time::Duration::from_millis(20)));
            let later = t0 + std::time::Duration::from_millis(25);
            assert!(should_redraw(Some(t0), later, std::time::Duration::from_millis(20)));
        }

        #[test]
        fn ansi_to_spans_maps_styles() {
            let line = ansi_line_to_spans("[1;36mhi[0m");
            let spans = line.spans;
            assert_eq!(spans.len(), 1);
            assert_eq!(spans[0].content, "hi");
            assert!(spans[0].style.add_modifier.contains(Modifier::BOLD));
            assert_eq!(spans[0].style.fg, Some(Color::Cyan));
        }


    }

