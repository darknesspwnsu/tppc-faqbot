// tools/metrics_export.js
// Admin command for exporting metrics snapshots.

import { isAdminOrPrivileged } from "../auth.js";
import { exportMetricsSnapshot, scheduleMetricsExport } from "../shared/metrics_export.js";
import { registerScheduler } from "../shared/scheduler_registry.js";

export function registerMetricsExport(register) {
  register(
    "!exportmetrics",
    async ({ message }) => {
      if (!isAdminOrPrivileged(message)) {
        await message.reply("You do not have permission to export metrics.");
        return;
      }

      const res = await exportMetricsSnapshot({ reason: "manual" });
      if (res.ok) {
        await message.reply("✅ Metrics export complete.");
        return;
      }

      if (res.reason === "missing_config") {
        await message.reply("❌ Metrics export is not configured.");
        return;
      }

      if (res.reason === "in_flight") {
        await message.reply("⏳ Metrics export already in progress.");
        return;
      }

      await message.reply("❌ Metrics export failed. Check logs for details.");
    },
    "!exportmetrics — export metrics snapshot",
    { admin: true, aliases: ["!export"] }
  );
}

export function registerMetricsExportScheduler() {
  registerScheduler("metrics_export", () => scheduleMetricsExport());
}
