//! celestea-workers：WorkersPlugin / WatchdogPlugin 插件挂载（W185/W186）。

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use celestea_core::{AgentLoopService, Context, LlmService, Plugin, ToolRegistry, ToolRegistryService};
use celestea_tools::{builtin_tools, ToolRegistryImpl};

use crate::registry::{WorkerRegistryService, WorkerRegistry};
use crate::tools::worker_tools_with;
use crate::watchdog::{Watchdog, WatchdogConfig};

pub struct WorkersPlugin {
    reg: Arc<WorkerRegistry>,
}

impl WorkersPlugin {
    /// 默认 /tmp registry 路径。
    pub fn new() -> Self {
        Self::with_registry(Arc::new(WorkerRegistry::with_default_path()))
    }

    /// 共享外部构造的 registry（测试 / 组合场景）。
    pub fn with_registry(reg: Arc<WorkerRegistry>) -> Self {
        Self { reg }
    }

    /// 自定义 registry.tsv 落盘路径。
    pub fn with_path(path: impl Into<PathBuf>) -> Self {
        Self::with_registry(Arc::new(WorkerRegistry::new(path)))
    }

    pub fn registry(&self) -> &Arc<WorkerRegistry> {
        &self.reg
    }
}

impl Default for WorkersPlugin {
    fn default() -> Self {
        Self::new()
    }
}

impl Plugin for WorkersPlugin {
    fn name(&self) -> &'static str {
        "celestea-workers"
    }

    fn mount(&self, ctx: &mut Context) {
        // 注入后台驱动 seam（缺任一则 spawn 仅登记不驱动）。
        let llm = ctx.get::<LlmService>();
        let tools = ctx.get::<ToolRegistryService>();
        let agent_loop = ctx.get::<AgentLoopService>().map(|s| s.0.clone());
        self.reg.attach_drivers(llm, tools, agent_loop);

        // provide WorkerRegistry 服务（get::<WorkerRegistryService>() 取回 Arc）。
        ctx.provide(WorkerRegistryService(self.reg.clone()));

        // ToolRegistryService 只暴露不可变 Deref（Arc<dyn ToolRegistry>），挂载后
        // 无法向宿主已共享的注册表注入工具；按 core 的 patch 语义（后 provide 替换
        // 先 provide），provide 一个 builtin + workers 三工具的组合注册表，使 agent
        // 的工具面包含这三个内置能力。
        let mut combined = ToolRegistryImpl::new();
        for tool in builtin_tools() {
            combined.register(tool);
        }
        for tool in worker_tools_with(self.reg.clone()) {
            combined.register(tool);
        }
        ctx.provide(ToolRegistryService(Arc::new(combined)));
    }
}


// ============================================================================
// 7. WatchdogPlugin——看门狗后台巡检（W186）
// ============================================================================

/// 看门狗插件：mount 时（若尚未启动）spawn 一个 tokio 后台巡检循环，
/// 按配置 interval 周期性地跑一轮 [Watchdog::tick]。
///
/// 缺省使用默认配置（/server-center/runtime/worker-exec 结果与日志目录，
/// interval 30s / grace 10min / max_retries 2）；可用 [WatchdogPlugin::with_config]
/// 覆盖，或 [WatchdogPlugin::with_for_test] 指向临时目录。
pub struct WatchdogPlugin {
    watchdog: Arc<Watchdog>,
    interval: Duration,
}

impl WatchdogPlugin {
    /// 默认 registry（/tmp registry.tsv）+ 默认看门狗配置。
    pub fn new() -> Self {
        Self::with_registry(Arc::new(WorkerRegistry::with_default_path()))
    }

    /// 绑定外部 registry + 默认配置（组合/测试场景）。
    pub fn with_registry(reg: Arc<WorkerRegistry>) -> Self {
        Self::with(reg, WatchdogConfig::default())
    }

    /// 自定义 registry + 任意配置。
    pub fn with(reg: Arc<WorkerRegistry>, config: WatchdogConfig) -> Self {
        let interval = config.interval;
        Self { watchdog: Arc::new(Watchdog::new(reg, config)), interval }
    }

    pub fn watchdog(&self) -> &Arc<Watchdog> {
        &self.watchdog
    }
}

impl Default for WatchdogPlugin {
    fn default() -> Self {
        Self::new()
    }
}

impl Plugin for WatchdogPlugin {
    fn name(&self) -> &'static str {
        "celestea-workers-watchdog"
    }

    fn mount(&self, ctx: &mut Context) {
        // 共享同一 WorkerRegistry（若上层已挂 WorkersPlugin，provide 会替换）。
        ctx.provide(WorkerRegistryService(self.watchdog.registry().clone()));

        let wd = self.watchdog.clone();
        let interval = self.interval;
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(interval);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                ticker.tick().await;
                if let Err(e) = wd.tick().await {
                    eprintln!("[celestea-workers] watchdog tick failed: {e}");
                }
            }
        });
    }
}

