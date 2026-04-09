import { buildPushPayload } from "@block65/webcrypto-web-push";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const ALLOWED_FORCE_TYPES = new Set([
  "daily_briefing",
  "reward_ready",
  "decay_warning",
  "boss_ready",
  "remaining_quests",
  "attribute_imbalance",
  "training_opportunity"
]);

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(dispatchNotifications(env, { source: "cron", cron: controller.cron }));
  }
};

async function handleRequest(request, env) {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(env) });
  }

  try {
    if (url.pathname === "/health" && request.method === "GET") {
      return jsonResponse(await getHealth(env), env);
    }

    if (url.pathname === "/api/notifications/subscribe" && request.method === "POST") {
      const body = await request.json();
      return jsonResponse(await handleSubscribe(body, env), env);
    }

    if (url.pathname === "/api/notifications/state" && request.method === "POST") {
      const body = await request.json();
      return jsonResponse(await handleStateSync(body, env), env);
    }

    if (url.pathname === "/api/notifications/test" && request.method === "POST") {
      const body = await request.json();
      return jsonResponse(await handleTest(body, env), env);
    }

    if (url.pathname === "/api/notifications/dispatch" && (request.method === "POST" || request.method === "GET")) {
      await assertCronSecret(request, env);
      const body = request.method === "POST" ? await safeJson(request) : {};
      const forcedType = (url.searchParams.get("force") || body.force || "").trim();
      if (forcedType && !ALLOWED_FORCE_TYPES.has(forcedType)) {
        return jsonResponse({ ok: false, error: "invalid force type" }, env, 400);
      }
      return jsonResponse(await dispatchNotifications(env, { source: "http", forcedType }), env);
    }

    return jsonResponse({ ok: false, error: "not found" }, env, 404);
  } catch (error) {
    return jsonResponse(
      {
        ok: false,
        error: error.message || "unexpected error"
      },
      env,
      error.statusCode || 500
    );
  }
}

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

function jsonResponse(payload, env, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...JSON_HEADERS,
      ...corsHeaders(env)
    }
  });
}

async function safeJson(request) {
  const text = await request.text();
  if (!text) return {};
  return JSON.parse(text);
}

async function assertCronSecret(request, env) {
  const url = new URL(request.url);
  const supplied =
    request.headers.get("x-cron-secret") ||
    url.searchParams.get("secret") ||
    "";
  if (!env.CRON_SECRET || supplied !== env.CRON_SECRET) {
    const error = new Error("invalid cron secret");
    error.statusCode = 401;
    throw error;
  }
}

async function getHealth(env) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM devices").first();
  return {
    ok: true,
    storage: "cloudflare-d1",
    devices: Number(row?.count || 0),
    cronConfigured: true
  };
}

async function handleSubscribe(body, env) {
  const now = new Date().toISOString();
  const deviceId = String(body.deviceId || "").trim();
  const subscription = body.subscription;
  if (!deviceId || !subscription?.endpoint) {
    const error = new Error("deviceId and subscription are required");
    error.statusCode = 400;
    throw error;
  }

  const timezone = body.timezone || body.snapshot?.timezone || "UTC";
  const profileName = body.profileName || body.snapshot?.profileName || "PETER";
  const snapshot = normalizeSnapshot({
    ...(body.snapshot || {}),
    deviceId,
    timezone,
    profileName
  });

  await env.DB.prepare(
    `INSERT INTO devices (
      device_id, profile_name, timezone, subscription_json, snapshot_json, created_at, updated_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET
      profile_name = excluded.profile_name,
      timezone = excluded.timezone,
      subscription_json = excluded.subscription_json,
      snapshot_json = excluded.snapshot_json,
      updated_at = excluded.updated_at,
      last_seen_at = excluded.last_seen_at`
  )
    .bind(
      deviceId,
      profileName,
      timezone,
      JSON.stringify(subscription),
      JSON.stringify(snapshot),
      now,
      now,
      now
    )
    .run();

  return { ok: true, deviceId, stored: true };
}

async function handleStateSync(body, env) {
  const deviceId = String(body.deviceId || "").trim();
  if (!deviceId) {
    const error = new Error("deviceId is required");
    error.statusCode = 400;
    throw error;
  }

  const current = await getDevice(env, deviceId);
  if (!current) {
    const error = new Error("device not registered");
    error.statusCode = 404;
    throw error;
  }

  const now = new Date().toISOString();
  const snapshot = normalizeSnapshot({
    ...(current.snapshot || {}),
    ...body,
    deviceId,
    timezone: body.timezone || current.timezone || "UTC",
    profileName: body.profileName || current.profileName || "PETER",
    lastOpenAt: body.lastOpenAt || now
  });

  await env.DB.prepare(
    `UPDATE devices
      SET profile_name = ?, timezone = ?, snapshot_json = ?, updated_at = ?, last_seen_at = ?
      WHERE device_id = ?`
  )
    .bind(
      snapshot.profileName,
      snapshot.timezone,
      JSON.stringify(snapshot),
      now,
      now,
      deviceId
    )
    .run();

  return { ok: true, deviceId, syncedAt: now };
}

async function handleTest(body, env) {
  const deviceId = String(body.deviceId || "").trim();
  if (!deviceId) {
    const error = new Error("deviceId is required");
    error.statusCode = 400;
    throw error;
  }

  const device = await getDevice(env, deviceId);
  if (!device) {
    const error = new Error("device not registered");
    error.statusCode = 404;
    throw error;
  }

  const type = String(body.type || "daily_briefing").trim();
  const payload = body.payload || buildPayload(type, device.snapshot);
  try {
    await sendPush(device.subscription, payload, env);
    return { ok: true, type, title: payload.title };
  } catch (error) {
    await maybePruneDevice(env, device.deviceId, error);
    throw error;
  }
}

async function dispatchNotifications(env, options = {}) {
  const rows = await env.DB.prepare(
    "SELECT device_id, profile_name, timezone, subscription_json, snapshot_json FROM devices"
  ).all();
  const devices = rows.results.map(parseDeviceRow);
  let sent = 0;
  let skipped = 0;
  const results = [];

  for (const device of devices) {
    const forcedType = options.forcedType || "";
    if (!forcedType && await hasRecentDelivery(env, device.deviceId, 60)) {
      skipped += 1;
      continue;
    }
    const type = forcedType || (await chooseScheduledType(env, device));
    if (!type) {
      skipped += 1;
      continue;
    }

    const payload = buildPayload(type, device.snapshot);
    try {
      await sendPush(device.subscription, payload, env);
      await recordDelivery(env, device.deviceId, type, device.timezone);
      sent += 1;
      results.push({ deviceId: device.deviceId, type, title: payload.title });
    } catch (error) {
      const pruned = await maybePruneDevice(env, device.deviceId, error);
      results.push({
        deviceId: device.deviceId,
        type,
        error: error.message || "push failed",
        pruned
      });
    }
  }

  return {
    ok: true,
    source: options.source || "http",
    forcedType: options.forcedType || null,
    sent,
    skipped,
    devices: devices.length,
    results
  };
}

async function chooseScheduledType(env, device) {
  const snapshot = device.snapshot || {};
  const prefs = snapshot.notificationPrefs || {};
  const zone = device.timezone || snapshot.timezone || "UTC";
  const local = getLocalParts(zone);
  const sentToday = await getSentTypesForDay(env, device.deviceId, local.date);
  const wasSent = (type) => sentToday.has(type);
  const dailyRemaining = Number(snapshot.dailyRemaining || 0);
  const dailySelected = Number(snapshot.dailySelected || 0);

  if (boolEnabled(prefs.reward) && snapshot.dailyRewardReady && !wasSent("reward_ready") && local.hour >= 8 && local.hour < 22) {
    return "reward_ready";
  }

  if (boolEnabled(prefs.decay) && Array.isArray(snapshot.decayRisk) && snapshot.decayRisk.length && !wasSent("decay_warning") && local.hour >= 11 && local.hour < 19) {
    return "decay_warning";
  }

  if (boolEnabled(prefs.boss) && snapshot.bossActionAvailable && !wasSent("boss_ready") && local.hour >= 18 && local.hour < 22) {
    return "boss_ready";
  }

  const imbalance = getAttributeImbalance(snapshot);
  if (
    imbalance &&
    !wasSent("attribute_imbalance") &&
    local.hour >= 10 &&
    local.hour < 20
  ) {
    return "attribute_imbalance";
  }

  const trainingStat = pickTrainingOpportunityStat(snapshot, device.deviceId, local.date);
  if (
    trainingStat &&
    !wasSent("training_opportunity") &&
    local.hour >= 12 &&
    local.hour < 21
  ) {
    return "training_opportunity";
  }

  if (
    boolEnabled(prefs.morning) &&
    dailySelected > 0 &&
    dailyRemaining > 0 &&
    !snapshot.dailyRewardReady &&
    !wasSent("daily_briefing") &&
    local.hour >= 6 &&
    local.hour < 11
  ) {
    return "daily_briefing";
  }

  if (
    boolEnabled(prefs.evening) &&
    Number(snapshot.remainingQuests || snapshot.dailyRemaining || 0) > 0 &&
    !wasSent("remaining_quests") &&
    local.hour >= 19 &&
    local.hour < 23
  ) {
    return "remaining_quests";
  }

  return null;
}

function buildPayload(type, snapshot = {}) {
  const name = snapshot.profileName || "HUNTER";
  if (type === "reward_ready") {
    return {
      title: "Daily Reward Ready",
      body: snapshot.dailyRewardReady
        ? `${name}, your bonus reward is ready for absorption.`
        : "A reward window has opened in the System.",
      tag: "reward-ready",
      data: { target: "reward" }
    };
  }

  if (type === "decay_warning") {
    const stat = Array.isArray(snapshot.decayRisk) && snapshot.decayRisk[0] ? snapshot.decayRisk[0] : "dis";
    const labelMap = {
      str: "Strength",
      int: "Intelligence",
      vit: "Vitality",
      con: "Self Control",
      dis: "Discipline"
    };
    return {
      title: "Decay Warning",
      body: `${labelMap[stat] || "A stat lane"} is degrading. Train it today to stabilize the System.`,
      tag: `decay-${stat}`,
      data: { target: "stat", stat }
    };
  }

  if (type === "boss_ready") {
    const statKey = String(snapshot.bossWeakStat || "").trim().toLowerCase();
    const statName = String(snapshot.bossStatName || getStatLabel(statKey || "dis")).toUpperCase();
    return {
      title: "RAID WINDOW OPEN",
      body: buildBossReadyBody(snapshot, statName),
      tag: "boss-ready",
      data: { target: "boss" }
    };
  }

  if (type === "remaining_quests") {
    const remaining = Number(snapshot.remainingQuests || snapshot.dailyRemaining || 0);
    return {
      title: "Evening Closeout",
      body: remaining > 0
        ? `${remaining} gate${remaining === 1 ? "" : "s"} remain open today. Close them before reset.`
        : "No open gates detected.",
      tag: "evening-closeout",
      data: { target: "remaining" }
    };
  }

  if (type === "attribute_imbalance") {
    const imbalance = getAttributeImbalance(snapshot);
    const weakest = imbalance?.weakest || "dis";
    const statName = getStatLabel(weakest);
    return {
      title: "ATTRIBUTE IMBALANCE DETECTED",
      body: `${statName.toUpperCase()} is below current combat standard. Reinforcement required.`,
      tag: `imbalance-${weakest}`,
      data: { target: "stat_focus", stat: weakest }
    };
  }

  if (type === "training_opportunity") {
    const stat = pickTrainingOpportunityStat(snapshot, snapshot.deviceId || "seed", snapshot.date || "");
    const lines = {
      str: "Strength reinforcement remains available. Power is not retained without use.",
      int: "Intelligence expansion path remains open. Untapped cognition is wasted capacity.",
      vit: "Vitality reinforcement remains available. Endurance improves only under load.",
      con: "Self Control can still be strengthened. Resistance is built through execution.",
      dis: "Discipline output remains unfinished. Consistency is still below possible yield."
    };
    return {
      title: "TRAINING OPPORTUNITY DETECTED",
      body: lines[stat] || lines.dis,
      tag: `training-${stat || "dis"}`,
      data: { target: "stat_focus", stat: stat || "dis" }
    };
  }

  return {
    title: "Morning Briefing",
    body: snapshot.dailySelected
      ? `${snapshot.dailyRemaining || 0} daily quest${Number(snapshot.dailyRemaining || 0) === 1 ? "" : "s"} remain active. Enter the System and clear today's directives.`
      : "Today's directives are not fully assigned yet.",
    tag: "daily-briefing",
    data: { target: "daily_briefing" }
  };
}

async function sendPush(subscription, payload, env) {
  const requestInit = await buildPushPayload(
    {
      data: JSON.stringify(payload),
      options: {
        ttl: 300,
        urgency: "high"
      }
    },
    subscription,
    {
      subject: env.VAPID_SUBJECT,
      publicKey: env.VAPID_PUBLIC_KEY,
      privateKey: env.VAPID_PRIVATE_KEY
    }
  );

  const response = await fetch(subscription.endpoint, requestInit);
  if (!response.ok) {
    const error = new Error(`push send failed (${response.status})`);
    error.statusCode = response.status;
    error.body = await response.text();
    throw error;
  }
  return response;
}

async function maybePruneDevice(env, deviceId, error) {
  if (!error || (error.statusCode !== 404 && error.statusCode !== 410)) {
    return false;
  }
  await env.DB.prepare("DELETE FROM devices WHERE device_id = ?").bind(deviceId).run();
  await env.DB.prepare("DELETE FROM deliveries WHERE device_id = ?").bind(deviceId).run();
  return true;
}

async function recordDelivery(env, deviceId, type, timezone) {
  const now = new Date().toISOString();
  const sentOn = getLocalParts(timezone || "UTC").date;
  await env.DB.prepare(
    "INSERT OR REPLACE INTO deliveries (device_id, type, sent_on, sent_at) VALUES (?, ?, ?, ?)"
  )
    .bind(deviceId, type, sentOn, now)
    .run();
}

async function getSentTypesForDay(env, deviceId, date) {
  const rows = await env.DB.prepare(
    "SELECT type FROM deliveries WHERE device_id = ? AND sent_on = ?"
  )
    .bind(deviceId, date)
    .all();
  return new Set(rows.results.map((row) => row.type));
}

async function hasRecentDelivery(env, deviceId, minutes) {
  const row = await env.DB.prepare(
    "SELECT sent_at FROM deliveries WHERE device_id = ? ORDER BY sent_at DESC LIMIT 1"
  )
    .bind(deviceId)
    .first();
  if (!row?.sent_at) return false;
  return Date.now() - Date.parse(row.sent_at) < minutes * 60 * 1000;
}

async function getDevice(env, deviceId) {
  const row = await env.DB.prepare(
    "SELECT device_id, profile_name, timezone, subscription_json, snapshot_json FROM devices WHERE device_id = ?"
  )
    .bind(deviceId)
    .first();
  return row ? parseDeviceRow(row) : null;
}

function parseDeviceRow(row) {
  return {
    deviceId: row.device_id,
    profileName: row.profile_name,
    timezone: row.timezone,
    subscription: JSON.parse(row.subscription_json),
    snapshot: JSON.parse(row.snapshot_json || "{}")
  };
}

function normalizeSnapshot(snapshot) {
  return {
    ...snapshot,
    deviceId: String(snapshot.deviceId || "").trim(),
    profileName: snapshot.profileName || "PETER",
    timezone: snapshot.timezone || "UTC",
    notificationPrefs: {
      morning: true,
      evening: true,
      decay: true,
      reward: true,
      boss: true,
      ...(snapshot.notificationPrefs || {})
    }
  };
}

function getStatLabel(stat) {
  return {
    str: "Strength",
    int: "Intelligence",
    vit: "Vitality",
    con: "Self Control",
    dis: "Discipline"
  }[stat] || "Attribute";
}

function buildBossReadyBody(snapshot, statName) {
  if (snapshot.bossDone) {
    return "The weekly raid is already clear.";
  }
  const variants = [
    `The weekly boss is vulnerable. ${statName} deals bonus damage tonight.`,
    `Raid target exposed. ${statName} is the current weakness.`,
    `Execution window open. ${statName} will inflict amplified damage.`
  ];
  const seed = `${snapshot.date || ""}:${snapshot.bossName || ""}:${statName}`;
  return variants[hashString(seed) % variants.length];
}

function getAttributeImbalance(snapshot) {
  const points = snapshot.statPoints || {};
  const pending = snapshot.pendingByStat || {};
  const stats = ["str", "int", "vit", "con", "dis"].map((stat) => ({
    stat,
    pts: Number(points[stat] || 0)
  })).sort((a, b) => a.pts - b.pts);
  const weakest = stats[0];
  const strongest = stats[stats.length - 1];
  if (!weakest || !strongest) return null;
  const gap = strongest.pts - weakest.pts;
  if (gap < 5) return null;
  if (Number(pending[weakest.stat] || 0) <= 0) return null;
  return { weakest: weakest.stat, strongest: strongest.stat, gap };
}

function pickTrainingOpportunityStat(snapshot, seedBase, dateKey) {
  const pending = snapshot.pendingByStat || {};
  const points = snapshot.statPoints || {};
  const activity = snapshot.activityTodayByStat || {};
  const stats = ["str", "int", "vit", "con", "dis"];
  const avg = stats.reduce((sum, stat) => sum + Number(points[stat] || 0), 0) / stats.length;
  const weighted = [];
  stats.forEach((stat) => {
    const pendingCount = Number(pending[stat] || 0);
    if (pendingCount <= 0) return;
    const deficit = Math.max(0, Math.round(avg - Number(points[stat] || 0)));
    const freshness = activity[stat] ? 0 : 2;
    const score = Math.max(1, pendingCount * 2 + deficit + freshness);
    for (let i = 0; i < score; i += 1) weighted.push(stat);
  });
  if (!weighted.length) return null;
  const seed = hashString(`${seedBase}:${dateKey}:${weighted.join("|")}`);
  return weighted[seed % weighted.length];
}

function hashString(input) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0);
}

function boolEnabled(value, fallback = true) {
  return typeof value === "boolean" ? value : fallback;
}

function getLocalParts(timezone, date = new Date()) {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone || "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const values = Object.fromEntries(dtf.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    hour: Number(values.hour),
    minute: Number(values.minute)
  };
}
