// calculator.js

function parseNum(raw) {
  // Accept: "123", "1,234", "42.5", "42_500", "  100162  "
  const s = String(raw ?? "")
    .trim()
    .replace(/[, _]/g, ""); // remove commas, spaces, underscores
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function formatInt(n) {
  const x = Math.round(n);
  return x.toLocaleString("en-US");
}

function toBillions(exp) {
  return exp / 1e9;
}

function formatBillionsFromExp(exp) {
  return `${toBillions(exp).toFixed(2)} bil`;
}

function formatBillions(bil) {
  return `${bil.toFixed(2)} bil`;
}

function levelToExp(level) {
  // Exp = Level^3 + 1
  return Math.pow(level, 3) + 1;
}

function expToLevel(exp) {
  // Inverse-ish of Exp = L^3 + 1:
  // Return largest integer L such that L^3 + 1 <= exp
  if (exp < 1) return 0;
  const t = exp - 1;
  const approx = Math.cbrt(t);
  let L = Math.floor(approx);

  // Correct for floating error / non-perfect cubes
  while (levelToExp(L + 1) <= exp) L++;
  while (L > 0 && levelToExp(L) > exp) L--;

  return L;
}

function fromBillions(bil) {
  return bil * 1e9;
}

// ---- Selling math (from sell_guide) ----
// TotalExp(L) = L^3 + 1
// MarketPrice(L) = 10 * TotalExp(L) = 10*(L^3 + 1)
//
// Buyer pays:
//   - no PP: MarketPrice(L)
//   - PP: floor(MarketPrice(L) * 2/3)
//
// Seller receives (independent of PP):
//   - floor(MarketPrice(L) / 2)

function marketPriceAtLevel(level) {
  return 10 * levelToExp(level);
}

function buyerPaysAtLevel(level, ppEnabled) {
  const mp = marketPriceAtLevel(level);
  return ppEnabled ? Math.floor((mp * 2) / 3) : mp;
}

function sellerGetsAtLevel(level) {
  const mp = marketPriceAtLevel(level);
  return Math.floor(mp / 2);
}

// Find minimum integer L such that f(L) >= target, where f(L) is monotonic increasing.
function minLevelForTarget(target, f) {
  if (!Number.isFinite(target) || target <= 0) return null;

  let lo = 1;
  let hi = 1;

  // Expand hi until it satisfies.
  while (f(hi) < target) {
    hi *= 2;
    // Prevent infinite loops on weird input
    if (hi > 50_000_000) return null;
  }

  // Binary search for minimum satisfying level.
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (f(mid) >= target) hi = mid;
    else lo = mid + 1;
  }

  return lo;
}

function levelForBuyerPays(target, ppEnabled) {
  return minLevelForTarget(target, (L) => buyerPaysAtLevel(L, ppEnabled));
}

function levelForSellerGets(target) {
  return minLevelForTarget(target, (L) => sellerGetsAtLevel(L));
}

function helpText() {
  // Keep this as plain text; Discord will render it nicely.
  return [
    "**Calculator help**",
    "",
    "**Usage:**",
    "• `!calc <function> <inputs>`",
    "• `!calc help`",
    "",
    "**Functions:**",
    "• `l2e <level>` — Level → Exp (`Exp = Level^3 + 1`)",
    "• `l2eb <level>` — Level → Exp (in billions)",
    "• `e2l <exp>` — Exp → Level",
    "• `eb2l <exp_in_billions>` — Exp (billions) → Level",
    "• `la <lvl...>` — Add Levels (sum exp(levels) → level)",
    "• `ea <exp...>` — Add Exp values → level",
    "• `eba <exp_bil...>` — Add Exp values in billions → level",
    "• `ld <lvl1> <lvl2>` — Level difference (Exp diff → level)",
    "• `buy <money>` — Buyer pays money → minimum level (shows PP no/yes)",
    "• `buym <money_millions>` — Buyer pays (in millions) → minimum level (shows PP no/yes)",
    "• `sell <money>` — Seller receives money → minimum level (PP no/yes will match)",
    "• `sellm <money_millions>` — Seller receives (in millions) → minimum level (PP no/yes will match)",
    "",
    "**Examples:**",
    "• `!calc l2e 125`",
    "• `!calc l2eb 3500`",
    "• `!calc e2l 100,162`",
    "• `!calc eb2l 42.5`",
    "• `!calc la 100 200 300`",
    "• `!calc ea 100000 200000 300000`",
    "• `!calc eba 42.5 10 1.25`",
    "• `!calc ld 1500 1200`",
    "• `!calc buy 500000000`",
    "• `!calc buym 500`",
    "• `!calc sell 250000000`",
    "• `!calc sellm 250`"
  ].join("\n");
}

export function registerCalculator(register) {
  // One-line help for !help list:
  const helpOneLiner =
    "!calc — useful calculator functions for summing or converting levels or exp. For more info, type `!calc help`";

  async function handleCalc(message, rest) {
    const parts = rest.trim().split(/\s+/).filter(Boolean);

    if (parts.length === 0) {
      await message.reply("Usage: `!calc <function> <inputs>` (try `!calc help`)");
      return;
    }

    const fn = parts[0].toLowerCase();
    const args = parts.slice(1);

    if (fn === "help") {
      await message.reply(helpText());
      return;
    }

    const parseList = () => {
      if (args.length === 0) return null;
      const nums = [];
      for (const a of args) {
        const n = parseNum(a);
        if (n === null) return null;
        nums.push(n);
      }
      return nums;
    };

    const one = () => (args.length === 1 ? parseNum(args[0]) : null);

    // l2e / l2eb
    if (fn === "l2e" || fn === "l2eb") {
      const lvlRaw = one();
      if (lvlRaw === null) return;

      const lvl = Math.floor(lvlRaw);
      if (!Number.isFinite(lvl) || lvl < 0) return;

      const exp = levelToExp(lvl);
      if (fn === "l2eb") {
        await message.reply(`Level ${lvl} → Exp: ${formatBillionsFromExp(exp)}`);
      } else {
        await message.reply(`Level ${lvl} → Exp: ${formatInt(exp)}`);
      }
      return;
    }

    // e2l / eb2l
    if (fn === "e2l" || fn === "eb2l") {
      const expRaw = one();
      if (expRaw === null) return;

      const exp = fn === "eb2l" ? fromBillions(expRaw) : expRaw;
      if (!Number.isFinite(exp) || exp < 0) return;

      const lvl = expToLevel(exp);
      await message.reply(
        `${fn === "eb2l" ? `Exp ${formatBillions(expRaw)}` : `Exp ${formatInt(exp)}`} → Level: ${lvl}`
      );
      return;
    }

    // buy / buym (buyer pays -> level)
    if (fn === "buy" || fn === "buym") {
      const moneyRaw = one();
      if (moneyRaw === null) return;

      const target = fn === "buym" ? moneyRaw * 1_000_000 : moneyRaw;
      if (!Number.isFinite(target) || target <= 0) return;

      const lvlNo = levelForBuyerPays(target, false);
      const lvlYes = levelForBuyerPays(target, true);

      if (lvlNo === null || lvlYes === null) return;

      await message.reply(
        [
          `Buyer pays $${formatInt(target)} → minimum level`,
          `• PP: no  → Level ${lvlNo}`,
          `• PP: yes → Level ${lvlYes}`
        ].join("\n")
      );
      return;
    }

    // sell / sellm (seller receives -> level)
    if (fn === "sell" || fn === "sellm") {
      const moneyRaw = one();
      if (moneyRaw === null) return;

      const target = fn === "sellm" ? moneyRaw * 1_000_000 : moneyRaw;
      if (!Number.isFinite(target) || target <= 0) return;

      const lvl = levelForSellerGets(target);
      if (lvl === null) return;

      // Seller gets is independent of PP; show both for clarity, per your request.
      await message.reply(
        [
          `Seller receives $${formatInt(target)} → minimum level`,
          `• PP: no  → Level ${lvl}`,
          `• PP: yes → Level ${lvl}`
        ].join("\n")
      );
      return;
    }

    // ld: level difference (absolute)
    if (fn === "ld") {
      if (args.length !== 2) return;

      const a = parseNum(args[0]);
      const b = parseNum(args[1]);
      if (a === null || b === null) return;

      const l1 = Math.floor(a);
      const l2 = Math.floor(b);
      if (!Number.isFinite(l1) || !Number.isFinite(l2) || l1 < 0 || l2 < 0) return;

      const exp1 = levelToExp(l1);
      const exp2 = levelToExp(l2);
      const diffExp = Math.abs(exp1 - exp2);
      const diffLvl = expToLevel(diffExp);

      await message.reply(
        `Level diff (${l1} ↔ ${l2}) → Exp: ${formatInt(diffExp)} (${formatBillionsFromExp(
          diffExp
        )}) → Level: ${diffLvl}`
      );
      return;
    }

    // la: sum exp(levels) -> level
    if (fn === "la") {
      const lvlsRaw = parseList();
      if (!lvlsRaw) return;

      const lvls = lvlsRaw.map((x) => Math.floor(x));
      if (lvls.some((x) => !Number.isFinite(x) || x < 0)) return;

      const totalExp = lvls.reduce((sum, L) => sum + levelToExp(L), 0);
      const totalLvl = expToLevel(totalExp);

      await message.reply(
        `Levels [${lvls.join(", ")}] → Total Exp: ${formatInt(totalExp)} (${formatBillionsFromExp(
          totalExp
        )}) → Level: ${totalLvl}`
      );
      return;
    }

    // ea / eba: sum exp -> level
    if (fn === "ea" || fn === "eba") {
      const expsRaw = parseList();
      if (!expsRaw) return;

      const exps = expsRaw.map((x) => (fn === "eba" ? fromBillions(x) : x));
      if (exps.some((x) => !Number.isFinite(x) || x < 0)) return;

      const totalExp = exps.reduce((sum, e) => sum + e, 0);
      const totalLvl = expToLevel(totalExp);

      const listLabel =
        fn === "eba"
          ? `Exps [${expsRaw.map(formatBillions).join(", ")}]`
          : `Exps [${expsRaw.map((n) => formatInt(n)).join(", ")}]`;

      await message.reply(
        `${listLabel} → Total Exp: ${formatInt(totalExp)} (${formatBillionsFromExp(
          totalExp
        )}) → Level: ${totalLvl}`
      );
      return;
    }

    await message.reply("Unknown function. Try `!calc help`");
  }

  register(
    "!calculate",
    async ({ message, rest }) => handleCalc(message, rest),
    helpOneLiner,
    { aliases: ["!calc"] }
  );

  register(
    "!calculator",
    async ({ message, rest }) => {
      const arg = rest.trim().toLowerCase();
      if (!arg || arg === "help") {
        await message.reply(helpText());
      }
    },
    ""
  );
}
