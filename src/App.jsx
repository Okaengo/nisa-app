import { useState, useMemo, useRef, useImperativeHandle, forwardRef, useEffect } from "react";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, ReferenceLine } from "recharts";

const NISA_ANNUAL_LIMIT = 360;
const NISA_LIFETIME_LIMIT = 1800;
const TAX_RATE = 0.20315;

// ── 共通スタイル定数 ──
const S = {
  // 入力欄ベース
  inputBase: { fontSize: 16, fontWeight: 700, borderRadius: 6, padding: "4px 8px", textAlign: "right", outline: "none" },
  // 緑系入力（利回り・金額等）
  inputGreen: { background: "rgba(16,185,129,0.1)", border: "1px solid rgba(16,185,129,0.3)", color: "#6ee7b7" },
  // 黄系入力（リスク・ボーナス等）
  inputYellow: { background: "rgba(251,191,36,0.1)", border: "1px solid rgba(251,191,36,0.3)", color: "#fbbf24" },
  // 赤系入力（インフレ率等）
  inputRed: { background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)", color: "#f87171" },
  // 紫系入力（放置期間等）
  inputPurple: { background: "rgba(167,139,250,0.15)", border: "1px solid rgba(167,139,250,0.35)", color: "#a78bfa" },
  // テーブルセル
  td: { padding: "5px 10px", textAlign: "right" },
  tdSm: { padding: "5px 10px", textAlign: "right", fontSize: 10 },
  // ラベル
  labelSm: { fontSize: 10, color: "#4b5563" },
  labelGreen: { fontSize: 13, color: "#a7f3d0" },
};

const CONTRIB_METHODS = [
  { value: "monthly",   label: "毎月積み立て" },
  { value: "lump_jan",  label: "年始一括（1月）" },
  { value: "lump_apr",  label: "年度始一括（4月）" },
  { value: "quarterly", label: "四半期ごと（3ヶ月に1回）" },
];

function monthlyContribArray(perAmount, method) {
  const arr = new Array(12).fill(0);
  if (perAmount <= 0) return arr;
  switch (method) {
    case "lump_jan":  arr[0] = perAmount; break;
    case "lump_apr":  arr[3] = perAmount; break;
    case "quarterly": [0,3,6,9].forEach(m => { arr[m] = perAmount; }); break;
    default:          arr.forEach((_, i) => { arr[i] = perAmount; }); break;
  }
  return arr;
}

function toAnnual(perAmount, method) {
  if (!perAmount) return 0;
  switch (method) {
    case "lump_jan":
    case "lump_apr":  return perAmount;
    case "quarterly": return perAmount * 4;
    default:          return perAmount * 12;
  }
}

const DEFAULT_PHASES = [
  { id: 1, label: "フェーズ1", amount: 0, method: "monthly", bonusPerTime: 0, bonusTimes: 0, years: 0, months: 0 },
];

const INITIAL_SIM_STATE = {
  phases: DEFAULT_PHASES,
  annualReturn: 0,
  annualRisk: 0,
  inflationRate: 0,
  coastMonths: 0,
  startMonth: 1,
  startYear: new Date().getFullYear(),
  startAge: 0,
  useStartDate: false,
  showFire: false,
  fireMonthly: 0,
  fireRate: 4,
  fireTargetYear: 0,
  fireTargetMonth: 1,
  fillPanel: null,
};

function formatMan(value) {
  if (value == null || isNaN(value)) return "—";
  if (Math.abs(value) >= 10000) return `${(value / 10000).toFixed(1)}億円`;
  return `${Math.round(value).toLocaleString()}万円`;
}

function periodLabel(years, months) {
  const totalMonths = (years || 0) * 12 + (months || 0);
  if (totalMonths === 0) return "0ヶ月";
  const y = Math.floor(totalMonths / 12);
  const m = totalMonths % 12;
  if (y === 0) return `${m}ヶ月`;
  if (m === 0) return `${y}年`;
  return `${y}年${m}ヶ月`;
}

function CustomTooltip({ active, payload, label, coastStartMonth }) {
  if (!active || !payload?.length) return null;
  const isCoast = coastStartMonth != null && Number(label) >= coastStartMonth;
  return (
    <div style={{ background: "rgba(8,16,12,0.97)", border: `1px solid ${isCoast ? "#a78bfa" : "#10b981"}`, borderRadius: 10, padding: "14px 18px", fontSize: 12, color: "#e2f5ec", boxShadow: "0 4px 24px rgba(16,185,129,0.25)", minWidth: 220 }}>
      <div style={{ fontWeight: 700, marginBottom: 10, color: isCoast ? "#c4b5fd" : "#6ee7b7", borderBottom: `1px solid ${isCoast ? "rgba(167,139,250,0.2)" : "rgba(16,185,129,0.2)"}`, paddingBottom: 6 }}>
        {label}年目 {isCoast ? "🌙 放置中" : ""}
      </div>
      {payload.map((p) => (
        <div key={p.name} style={{ display: "flex", justifyContent: "space-between", gap: 20, marginBottom: 3 }}>
          <span style={{ color: p.color }}>{p.name}</span>
          <span style={{ fontWeight: 700 }}>{formatMan(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

// ── シミュレーション本体（純粋関数） ──
function runSim(state) {
  const { phases, annualReturn, annualRisk, inflationRate, coastMonths, startMonth, startYear, useStartDate } = state;
  const sYear = useStartDate ? (startYear || new Date().getFullYear()) : 2000;
  const sMonth = useStartDate ? (startMonth || 1) : 1;

  function simulate(rate) {
    const realRate = rate - inflationRate;
    const monthlyRate = realRate / 100 / 12;
    let nisaBalance = 0, taxableBalance = 0, taxableCost = 0, nisaUsed = 0, nisaUsedThisYear = 0, totalInvested = 0;
    const data = [];
    const bonusMonthSet = (times) => times <= 0 ? new Set() : times === 1 ? new Set([11]) : new Set([5, 11]);

    for (const phase of phases) {
      const totalPhaseMonths = (phase.years || 0) * 12 + (phase.months || 0);
      if (totalPhaseMonths <= 0) continue;
      const perAmount = phase.amount || 0;
      const bonusPerTime = phase.bonusPerTime || 0;
      const bSet = bonusMonthSet(phase.bonusTimes || 0);
      const monthContribs = monthlyContribArray(perAmount, phase.method);

      for (let pm = 0; pm < totalPhaseMonths; pm++) {
        const totalMonthIndex = data.length;
        const monthOfYear = totalMonthIndex % 12;
        const calendarMonth = ((sMonth - 1 + totalMonthIndex) % 12) + 1;
        const calendarYear = Math.floor((sMonth - 1 + totalMonthIndex) / 12);
        const isNewYear = calendarMonth === 1 && totalMonthIndex > 0;
        if (isNewYear) nisaUsedThisYear = 0;

        const contrib = monthContribs[monthOfYear];
        const nisaLifetimeRemain = Math.max(0, NISA_LIFETIME_LIMIT - nisaUsed);
        const nisaAnnualRemain = Math.max(0, NISA_ANNUAL_LIMIT - nisaUsedThisYear);
        const nisaContrib = Math.min(contrib, nisaLifetimeRemain, nisaAnnualRemain);
        const taxableContrib = contrib - nisaContrib;

        nisaBalance = nisaBalance * (1 + monthlyRate) + nisaContrib;
        taxableBalance = taxableBalance * (1 + monthlyRate) + taxableContrib;
        taxableCost += taxableContrib;
        nisaUsed = Math.min(nisaUsed + nisaContrib, NISA_LIFETIME_LIMIT);
        nisaUsedThisYear += nisaContrib;
        totalInvested += contrib;

        if (bSet.has(monthOfYear) && bonusPerTime > 0) {
          const nisaBonusL = Math.max(0, NISA_LIFETIME_LIMIT - nisaUsed);
          const nisaBonusA = Math.max(0, NISA_ANNUAL_LIMIT - nisaUsedThisYear);
          const nisaBonus = Math.min(bonusPerTime, nisaBonusL, nisaBonusA);
          const taxableBonus = bonusPerTime - nisaBonus;
          nisaBalance += nisaBonus; taxableBalance += taxableBonus; taxableCost += taxableBonus;
          nisaUsed = Math.min(nisaUsed + nisaBonus, NISA_LIFETIME_LIMIT);
          nisaUsedThisYear += nisaBonus;
          totalInvested += bonusPerTime;
        }
        const totalBalance = nisaBalance + taxableBalance;
        const taxableGain = Math.max(0, taxableBalance - taxableCost);
        const tax = taxableGain * TAX_RATE;
        data.push({
          month: data.length + 1, phase: phase.label, phaseId: phase.id, phaseMonthIndex: pm,
          isCoast: false, perAmount, method: phase.method, calendarMonth, calendarYear,
          actualYear: sYear + calendarYear,
          NISA口座: Math.round(nisaBalance), 特定口座: Math.round(taxableBalance),
          資産総額_税引前: Math.round(totalBalance), 資産総額_税引後: Math.round(totalBalance - tax),
          投資元本: Math.round(totalInvested), 特定口座運用益: Math.round(taxableGain),
          税額: Math.round(tax), NISA残枠: Math.round(Math.max(0, NISA_LIFETIME_LIMIT - nisaUsed)),
          nisaFull: nisaUsed >= NISA_LIFETIME_LIMIT,
        });
      }
    }

    const coastStart = data.length + 1;
    for (let cm = 0; cm < coastMonths; cm++) {
      nisaBalance = nisaBalance * (1 + monthlyRate);
      taxableBalance = taxableBalance * (1 + monthlyRate);
      const totalBalance = nisaBalance + taxableBalance;
      const taxableGain = Math.max(0, taxableBalance - taxableCost);
      const tax = taxableGain * TAX_RATE;
      const totalMonthIndex = data.length;
      const calendarMonth = ((sMonth - 1 + totalMonthIndex) % 12) + 1;
      const calendarYear = Math.floor((sMonth - 1 + totalMonthIndex) / 12);
      data.push({
        month: data.length + 1, phase: "放置", isCoast: true, perAmount: 0,
        calendarMonth, calendarYear, actualYear: sYear + calendarYear,
        NISA口座: Math.round(nisaBalance), 特定口座: Math.round(taxableBalance),
        資産総額_税引前: Math.round(totalBalance), 資産総額_税引後: Math.round(totalBalance - tax),
        投資元本: Math.round(totalInvested), 特定口座運用益: Math.round(taxableGain),
        税額: Math.round(tax), NISA残枠: 0, nisaFull: true,
      });
    }
    return { data, coastStart };
  }

  const { data, coastStart } = simulate(annualReturn);
  const bestData  = annualRisk > 0 ? simulate(annualReturn + annualRisk).data : null;
  const worstData = annualRisk > 0 ? simulate(annualReturn - annualRisk).data : null;

  const isYearEnd = (d) => d.calendarMonth === 12 || d === data[data.length - 1];
  const yearlyIndices = [];
  data.forEach((d, i) => { if (isYearEnd(d)) yearlyIndices.push(i); });

  const startCalendarYear = data[0]?.calendarYear ?? 0;

  const chartData = yearlyIndices.map(idx => {
    const d = data[idx];
    const actualYear = sYear + d.calendarYear;
    const yearLabel = d.calendarYear - startCalendarYear + 1;
    const row = { ...d, x: yearLabel, actualYear, 中央値: d.資産総額_税引前 };
    if (bestData && bestData[idx]) row["最良ケース"] = bestData[idx].資産総額_税引前;
    if (worstData && worstData[idx]) row["最悪ケース"] = worstData[idx].資産総額_税引前;
    return row;
  });

  const coastStartYear = coastMonths > 0 && data[coastStart - 2]
    ? data[coastStart - 2].calendarYear - startCalendarYear + 1
    : null;
  const balanceAtCoastStart = coastMonths > 0 && data[coastStart - 2] ? data[coastStart - 2].資産総額_税引前 : 0;
  const last = data[data.length - 1] || {};

  return {
    chartData,
    monthlyData: data,
    coastStartMonth: coastStartYear,
    hasTaxable: chartData.some(d => d.特定口座 > 0),
    summary: {
      finalBalance: last.資産総額_税引前 || 0,
      afterTaxBalance: last.資産総額_税引後 || 0,
      totalInvested: last.投資元本 || 0,
      totalTax: last.税額 || 0,
      balanceAtCoastStart,
      coastGrowth: (last.資産総額_税引前 || 0) - balanceAtCoastStart,
      bestFinal: bestData ? (bestData[bestData.length - 1]?.資産総額_税引前 || 0) : 0,
      worstFinal: worstData ? (worstData[worstData.length - 1]?.資産総額_税引前 || 0) : 0,
    },
  };
}

// ── FIRE結果パネル（年別推移の下） ──
function FireResult({ monthlyAmount, withdrawalRate, targetYear, targetMonth, chartData, monthlyData, useStartDate, startYear, state }) {
  if (!monthlyAmount) return null;
  const annualAmount = monthlyAmount * 12;
  const required = withdrawalRate > 0 ? Math.round(annualAmount / (withdrawalRate / 100)) : 0;

  let targetRow, label;
  if (targetYear > 0 && useStartDate && monthlyData) {
    const last = monthlyData[monthlyData.length - 1];
    const exactRow = monthlyData.find(d => d.actualYear === targetYear && d.calendarMonth >= targetMonth)
      ?? monthlyData.find(d => d.actualYear > targetYear);
    const isOver = !exactRow;
    targetRow = exactRow ?? last;
    label = isOver
      ? `最終時点（目標期間がシミュレーション期間を超えています）`
      : `${targetRow.actualYear}年${targetRow.calendarMonth}月時点`;
  } else if (targetYear > 0) {
    const last = chartData[chartData.length - 1];
    const row = chartData.find(d => d.x >= targetYear);
    const isOver = !row;
    targetRow = row ?? last;
    label = isOver
      ? `最終時点（目標期間がシミュレーション期間を超えています）`
      : `${targetRow.x}年目時点`;
  } else {
    targetRow = chartData[chartData.length - 1];
    label = "最終時点";
  }

  const balanceAtTarget = targetRow?.資産総額_税引後 ?? 0;
  const diff = balanceAtTarget - required;
  const achieved = balanceAtTarget >= required && required > 0;

  // 不足時の逆算（二分探索で最小増額を求める）
  let monthlyAdd = null;
  let yearsExtend = null;
  if (!achieved && required > 0 && diff < 0) {
    // 二分探索：全フェーズを均等に増額して達成できる最小額を求める
    const testSim = (addAmount) => {
      const testState = {
        ...state,
        phases: state.phases.map(p => ({ ...p, amount: (p.amount || 0) + addAmount }))
      };
      const result = runSim(testState);
      const targetRow = targetYear > 0
        ? (useStartDate
            ? result.chartData.find(d => d.actualYear >= targetYear)
            : result.chartData.find(d => d.x >= targetYear))
          ?? result.chartData[result.chartData.length - 1]
        : result.chartData[result.chartData.length - 1];
      return (targetRow?.資産総額_税引後 ?? 0) >= required;
    };

    let lo = 0, hi = 100, mid;
    for (let i = 0; i < 20; i++) {
      mid = Math.round((lo + hi) / 2 * 10) / 10;
      if (testSim(mid)) hi = mid;
      else lo = mid;
    }
    monthlyAdd = Math.ceil(hi * 10) / 10;

    // 目標年延長
    const lastBalance = chartData[chartData.length - 1]?.資産総額_税引後 ?? 0;
    if (lastBalance >= required) {
      const achieveRow = chartData.find(d => d.資産総額_税引後 >= required);
      if (achieveRow) {
        yearsExtend = useStartDate ? `${achieveRow.actualYear}年` : `${achieveRow.x}年目`;
      }
    }
  }

  return (
    <div style={{ borderTop: "1px solid rgba(16,185,129,0.1)", paddingTop: 16 }}>
      {/* 1行目：必要額・時点の額・不足額＋アドバイス */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 24, alignItems: "flex-start", marginBottom: achieved ? 0 : 12 }}>
        <div>
          <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 4 }}>FIRE必要資産（{withdrawalRate}%取り崩し）</div>
          <div style={{ fontSize: 22, fontWeight: 900, color: "#fff" }}>{required > 0 ? `${required.toLocaleString()}万円` : "—"}</div>
        </div>
        <div>
          <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 4 }}>{label}の税引後手取り</div>
          <div style={{ fontSize: 22, fontWeight: 900, color: "#6ee7b7" }}>{balanceAtTarget.toLocaleString()}万円</div>
        </div>
        <div>
          <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 4 }}>{achieved ? "余裕額" : "不足額"}</div>
          <div style={{ fontSize: 22, fontWeight: 900, color: achieved ? "#34d399" : "#f87171" }}>
            {achieved ? "+" : "▲"}{Math.abs(diff).toLocaleString()}万円
          </div>
          {!achieved && monthlyAdd !== null && (
            <div style={{ fontSize: 10, color: "#6b7280", marginTop: 4 }}>早い時期に増やすほど複利効果が高くなります。</div>
          )}
        </div>
        {achieved && (
          <div style={{ flex: 1, minWidth: 160 }}>
            <div style={{ fontSize: 13, color: "#6ee7b7", fontWeight: 700, lineHeight: 1.9 }}>
              🎉 目標達成！余裕分 {Math.abs(diff).toLocaleString()}万円は安全マージンになります。
            </div>
            {(() => {
              const finalBalance = chartData[chartData.length - 1]?.資産総額_税引後 ?? 0;
              const monthlyFromFinal = Math.floor(finalBalance * (withdrawalRate / 100) / 12 * 10) / 10;
              return (
                <div style={{ marginTop: 4, fontSize: 12, color: "#9ca3af", lineHeight: 1.9 }}>
                  最終資産{finalBalance.toLocaleString()}万円を{withdrawalRate}%で取り崩すと月{monthlyFromFinal.toLocaleString()}万円使えます。
                </div>
              );
            })()}
          </div>
        )}
      </div>
      {/* 不足時：提案を横幅フルで表示 */}
      {!achieved && (
        <div style={{ fontSize: 12, color: "#9ca3af", lineHeight: 2, borderTop: "1px solid rgba(16,185,129,0.08)", paddingTop: 10 }}>
          {monthlyAdd !== null && <div>・積立額を全体で月+{monthlyAdd}万円増やすと達成できます。</div>}
          {yearsExtend !== null && <div>・目標を{yearsExtend}まで延ばすと達成できます。</div>}
        </div>
      )}
    </div>
  );
}

// ── プラン単体コンポーネント ──
const PlanSimulator = forwardRef(function PlanSimulator({ planName, isActive, onHistoryChange, initialState }, ref) {
  const loadSaved = () => {
    try {
      const saved = localStorage.getItem(`nisa_plan_${planName}`);
      if (saved) return { ...INITIAL_SIM_STATE, ...JSON.parse(saved), fillPanel: null };
    } catch (e) {}
    return null;
  };
  const INITIAL_STATE = initialState ? { ...initialState, fillPanel: null } : (loadSaved() ?? { ...INITIAL_SIM_STATE });
  const [history, setHistory] = useState([INITIAL_STATE]);
  const [historyIdx, setHistoryIdx] = useState(0);
  const [working, setWorking] = useState(null);

  const current = history[historyIdx];
  const phases        = current.phases;
  const annualReturn  = working?.annualReturn  ?? current.annualReturn;
  const annualRisk    = working?.annualRisk    ?? current.annualRisk;
  const inflationRate = working?.inflationRate ?? current.inflationRate;
  const coastMonths   = working?.coastMonths   ?? current.coastMonths;
  const startMonth    = current.startMonth;
  const startYear     = current.startYear;
  const startAge      = current.startAge;
  const useStartDate  = current.useStartDate;
  const showFire      = current.showFire;
  const fireMonthly   = current.fireMonthly;
  const fireRate      = current.fireRate;
  const fireTargetYear  = current.fireTargetYear;
  const fireTargetMonth = current.fireTargetMonth;
  const fillPanel     = current.fillPanel;

  const canUndo = historyIdx > 0;
  const canRedo = historyIdx < history.length - 1;

  const pushHistory = (patch) => {
    const next = { ...current, ...patch };
    const changed = Object.keys(patch).some(k => JSON.stringify(next[k]) !== JSON.stringify(current[k]));
    if (!changed) return;
    const newHistory = [...history.slice(0, historyIdx + 1), next];
    const newIdx = historyIdx + 1;
    setHistory(newHistory);
    setHistoryIdx(newIdx);
    setWorking(null);
    onHistoryChange?.(newIdx > 0, newIdx < newHistory.length - 1, next);
  };

  const undo = () => {
    if (!canUndo) return;
    const newIdx = historyIdx - 1;
    setHistoryIdx(newIdx);
    setWorking(null);
    onHistoryChange?.(newIdx > 0, newIdx < history.length - 1, history[newIdx]);
  };
  const redo = () => {
    if (!canRedo) return;
    const newIdx = historyIdx + 1;
    setHistoryIdx(newIdx);
    setWorking(null);
    onHistoryChange?.(newIdx > 0, newIdx < history.length - 1, history[newIdx]);
  };

  useImperativeHandle(ref, () => ({ undo, redo, canUndo, canRedo, getCurrentState: () => current }));

  // ローカル保存（stateが変わるたびに自動保存）
  useEffect(() => {
    try {
      localStorage.setItem(`nisa_plan_${planName}`, JSON.stringify(current));
    } catch (e) {}
    onHistoryChange?.(historyIdx > 0, historyIdx < history.length - 1, current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  const setPhases        = (fn) => pushHistory({ phases: typeof fn === "function" ? fn(phases) : fn });
  const setAnnualReturn  = (v)  => pushHistory({ annualReturn: v });
  const setAnnualRisk    = (v)  => pushHistory({ annualRisk: v });
  const setInflationRate = (v)  => pushHistory({ inflationRate: v });
  const setCoastMonths   = (v)  => pushHistory({ coastMonths: v });
  const setStartMonth    = (v)  => pushHistory({ startMonth: v });
  const setStartYear     = (v)  => pushHistory({ startYear: v });
  const setStartAge      = (v)  => pushHistory({ startAge: v });
  const setUseStartDate  = (v)  => pushHistory({ useStartDate: typeof v === "function" ? v(useStartDate) : v });
  const setShowFire      = (fn) => pushHistory({ showFire: typeof fn === "function" ? fn(showFire) : fn });
  const setFireMonthly   = (v)  => pushHistory({ fireMonthly: v });
  const setFireRate      = (v)  => pushHistory({ fireRate: v });
  const setFireTargetYear  = (v) => pushHistory({ fireTargetYear: v });
  const setFireTargetMonth = (v) => pushHistory({ fireTargetMonth: v });
  const setFillPanel     = (v)  => pushHistory({ fillPanel: typeof v === "function" ? v(fillPanel) : v });

  const slideReturn    = (v) => setWorking(w => ({ ...current, ...w, annualReturn: v }));
  const slideRisk      = (v) => setWorking(w => ({ ...current, ...w, annualRisk: v }));
  const slideInflation = (v) => setWorking(w => ({ ...current, ...w, inflationRate: v }));

  const [showBonus, setShowBonus] = useState(true);
  const [showDetail, setShowDetail] = useState(false);
  const [drafts, setDrafts] = useState({});
  const getDraft = (id, field, fallback) => {
    const key = `${id}_${field}`;
    return key in drafts ? drafts[key] : String(fallback ?? "");
  };
  const onChangeNum = (id, field, raw) => setDrafts(d => ({ ...d, [`${id}_${field}`]: raw }));
  const onFocusNum  = (id, field, cur) => { if (Number(cur) === 0) setDrafts(d => ({ ...d, [`${id}_${field}`]: "" })); };
  const onBlurNum   = (id, field, raw, min = 0) => {
    const num = raw === "" ? min : Math.max(min, Number(raw) || min);
    // 金額フィールドは小数第2位まで、それ以外は整数
    const amountFields = ["amount", "bonusPerTime"];
    const parsed = amountFields.includes(field)
      ? Math.floor(num * 100) / 100
      : Math.floor(num);
    setDrafts(d => { const n = { ...d }; delete n[`${id}_${field}`]; return n; });
    setPhases(ps => ps.map(p => p.id === id ? { ...p, [field]: parsed } : p));
  };

  const [startYearDraft, setStartYearDraft] = useState("");
  const [startYearFocused, setStartYearFocused] = useState(false);
  const [startAgeDraft, setStartAgeDraft] = useState("");
  const [startAgeFocused, setStartAgeFocused] = useState(false);
  const [returnDraft, setReturnDraft] = useState("");
  const [riskDraft, setRiskDraft] = useState("");
  const [inflationDraft, setInflationDraft] = useState("");
  const [coastDraft, setCoastDraft] = useState("");
  const [coastMonthDraft, setCoastMonthDraft] = useState("");
  const [returnFocused, setReturnFocused] = useState(false);
  const [riskFocused, setRiskFocused] = useState(false);
  const [inflationFocused, setInflationFocused] = useState(false);
  const [fillYearsDraft, setFillYearsDraft] = useState("");
  const [fillYearsFocused, setFillYearsFocused] = useState(false);

  const scalarInput = (value, draft, setDraft, setter, focused, setFocused, min = 0, max = 999) => ({
    value: focused ? (draft === null ? "" : draft) : value,
    onFocus: () => { setFocused(true); setDraft(value === 0 ? null : String(value)); },
    onChange: e => { setDraft(e.target.value); },
    onBlur: e => {
      const raw = e.target.value;
      const parsed = (raw === "" || raw === null || raw === "-") ? min : Math.min(max, Math.max(min, Number(raw) || min));
      const v = Math.floor(parsed * 100) / 100;
      setter(v); setDraft(""); setFocused(false);
    },
  });

  const updatePhase = (id, field, value) =>
    setPhases(ps => ps.map(p => p.id === id ? { ...p, [field]: field === "label" || field === "method" ? value : Number(value) } : p));
  const addPhase = () => setPhases(ps => [...ps, { id: Date.now(), label: `フェーズ${ps.length + 1}`, amount: 0, method: "monthly", bonusPerTime: 0, bonusTimes: 0, years: 0, months: 0 }]);
  const removePhase = (id) => { if (phases.length > 1) setPhases(ps => ps.filter(p => p.id !== id)); };

  const calcFillProposal = (row, years) => {
    if (!years || years <= 0 || !row || row.NISA残枠 <= 0) return [];
    const nisaRemain = row.NISA残枠;
    const monthsInSelectedYear = row.calendarMonth;
    const totalFillMonths = monthsInSelectedYear + (years - 1) * 12;
    const targetPhase = phases.find(p => p.id === row.phaseId);
    const methods = new Set();
    if (targetPhase) methods.add(targetPhase.method || "monthly");
    const targetPhaseIdx = phases.findIndex(p => p.id === row.phaseId);
    if (targetPhaseIdx !== -1 && targetPhaseIdx + 1 < phases.length) {
      const remainInPhase = (targetPhase.years || 0) * 12 + (targetPhase.months || 0) - (row.phaseMonthIndex + 1);
      if (totalFillMonths > remainInPhase) methods.add(phases[targetPhaseIdx + 1].method || "monthly");
    }
    return [...methods].map(method => {
      let perAmount, label;
      switch (method) {
        case "lump_jan": case "lump_apr":
          perAmount = Math.ceil(nisaRemain / years * 10) / 10;
          label = method === "lump_jan" ? "年始一括" : "年度始一括"; break;
        case "quarterly":
          perAmount = Math.ceil(nisaRemain / (years * 4) * 10) / 10;
          label = "四半期ごと"; break;
        default:
          perAmount = Math.ceil(nisaRemain / totalFillMonths * 10) / 10;
          label = "毎月積み立て";
      }
      return { method, label, perAmount, annualAmount: toAnnual(perAmount, method) };
    });
  };

  const applyFillPhase = () => {
    if (!fillPanel) return;
    const { row, years, selectedMethod } = fillPanel;
    const proposal = fillPanel.proposal.find(p => p.method === selectedMethod) || fillPanel.proposal[0];
    if (!proposal) return;
    const { phaseId, phaseMonthIndex } = row;
    const idx = phases.findIndex(p => p.id === phaseId);
    if (idx === -1) return;
    const phase = phases[idx];
    const totalPhaseMonths = (phase.years || 0) * 12 + (phase.months || 0);
    const monthsInSelectedYear = row.calendarMonth;
    const beforeMonths = phaseMonthIndex + 1 - monthsInSelectedYear;
    const fillMonths = years * 12;
    const afterMonths = totalPhaseMonths - beforeMonths - fillMonths;
    const toInsert = [];
    const hasAfter = afterMonths > 0;
    const hasBefore = beforeMonths > 0;
    const now = Date.now();
    if (hasBefore) toInsert.push({ ...phase, id: now - 2, label: hasAfter ? `${phase.label}（前半）` : phase.label, years: Math.floor(beforeMonths / 12), months: beforeMonths % 12 });
    toInsert.push({ ...phase, id: now - 1, label: `${phase.label}（満額調整 ${years}年）`, method: proposal.method, amount: (phase.amount || 0) + proposal.perAmount, years: Math.floor(fillMonths / 12), months: fillMonths % 12 });
    if (hasAfter) toInsert.push({ ...phase, id: now, label: hasBefore ? `${phase.label}（後半）` : phase.label, years: Math.floor(afterMonths / 12), months: afterMonths % 12 });
    const newPhases = [...phases];
    newPhases.splice(idx, 1, ...toInsert);
    pushHistory({ phases: newPhases, fillPanel: null });
  };

  const [fireMonthlyDraft, setFireMonthlyDraft] = useState("");
  const [fireMonthlyFocused, setFireMonthlyFocused] = useState(false);
  const [fireRateDraft, setFireRateDraft] = useState("");
  const [fireRateFocused, setFireRateFocused] = useState(false);
  const [fireYearDraft, setFireYearDraft] = useState("");
  const [fireYearFocused, setFireYearFocused] = useState(false);
  const [fireAgeDraft, setFireAgeDraft] = useState("");
  const [fireAgeFocused, setFireAgeFocused] = useState(false);

  const simResult = useMemo(() => runSim(current), [current]);
  const { chartData, monthlyData, summary, coastStartMonth, hasTaxable } = simResult;

  const totalInvestMonths = phases.reduce((s, p) => s + (p.years || 0) * 12 + (p.months || 0), 0);
  const totalMonths = totalInvestMonths + coastMonths;

  const numInput = (w) => ({
    background: "rgba(16,185,129,0.1)", border: "1px solid rgba(16,185,129,0.25)",
    color: "#6ee7b7", fontSize: 16, fontWeight: 700, width: w,
    borderRadius: 6, padding: "4px 6px", textAlign: "right", outline: "none",
  });

  return (
    <div>

      {/* FIRE目標 ON/OFF */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <button onClick={() => setShowFire(v => !v)} style={{
            display: "flex", alignItems: "center", gap: 8,
            background: showFire ? "rgba(16,185,129,0.15)" : "rgba(16,185,129,0.04)",
            border: `1px solid ${showFire ? "rgba(16,185,129,0.5)" : "rgba(16,185,129,0.15)"}`,
            borderRadius: 8, padding: "8px 16px", cursor: "pointer",
            color: showFire ? "#6ee7b7" : "#4b5563", fontSize: 13, fontWeight: showFire ? 700 : 400,
          }}>
            🔥 {showFire ? "FIRE目標 ON" : "FIRE目標 OFF"}
          </button>
          <span style={{ fontSize: 10, color: "#6b7280" }}>目標金額・達成年月を設定し、シミュレーション結果と比較できます。</span>
        </div>
        {showFire && (
          <div style={{ marginTop: 8, background: "rgba(16,185,129,0.03)", border: "1px solid rgba(16,185,129,0.12)", borderRadius: 16, padding: 24, marginBottom: 22 }}>
            <div style={{ fontSize: 11, color: "#6ee7b7", letterSpacing: 3, marginBottom: 18 }}>🔥 FIRE目標設定</div>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>

              {/* 月額 */}
              <div style={{ flex: 1, minWidth: 180 }}>
                <div style={{ fontSize: 13, color: "#a7f3d0", marginBottom: 8 }}>FIRE後に月いくら必要？</div>
                <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
                  <input type="number" min={0} max={1000}
                    value={fireMonthlyFocused ? (fireMonthlyDraft === null ? "" : fireMonthlyDraft) : fireMonthly}
                    onFocus={() => { setFireMonthlyFocused(true); setFireMonthlyDraft(fireMonthly === 0 ? null : String(fireMonthly)); }}
                    onChange={e => setFireMonthlyDraft(e.target.value)}
                    onBlur={e => { const v = e.target.value === "" ? 0 : Math.floor(Math.max(0, Number(e.target.value) || 0) * 100) / 100; setFireMonthly(v); setFireMonthlyDraft(""); setFireMonthlyFocused(false); }}
                    style={{ ...S.inputBase, ...S.inputGreen, width: 80, borderRadius: 6, padding: "4px 8px", textAlign: "right", outline: "none" }} />
                  <span style={{ fontSize: 14, color: "#6ee7b7" }}>万円 / 月</span>
                  {fireMonthly > 0 && <span style={{ fontSize: 12, color: "#4b5563" }}>（年間 {fireMonthly * 12}万円）</span>}
                </div>
                {fireMonthly > 0 && fireRate > 0 && (
                  <div style={{ marginTop: 6, display: "flex", alignItems: "baseline", gap: 6 }}>
                    <span style={{ fontSize: 11, color: "#6b7280" }}>FIRE必要資産（{fireRate}%取り崩し）：</span>
                    <span style={{ fontSize: 18, fontWeight: 900, color: "#6ee7b7" }}>{Math.round(fireMonthly * 12 / (fireRate / 100)).toLocaleString()}万円</span>
                  </div>
                )}
              </div>

              {/* 取り崩し率 */}
              <div style={{ flex: 1, minWidth: 240 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <div>
                    <div style={{ fontSize: 13, color: "#a7f3d0" }}>年間取り崩し率</div>
                    <div style={{ fontSize: 10, color: "#6b7280", marginTop: 2 }}>必要資産 = 年間支出 ÷ 取り崩し率</div>
                  </div>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 2 }}>
                    <input type="number" min={1} max={10} step={0.1}
                      value={fireRateFocused ? (fireRateDraft === null ? "" : fireRateDraft) : fireRate}
                      onFocus={() => { setFireRateFocused(true); setFireRateDraft(String(fireRate)); }}
                      onChange={e => setFireRateDraft(e.target.value)}
                      onBlur={e => { const v = e.target.value === "" ? 4 : Math.floor(Math.min(10, Math.max(1, Number(e.target.value) || 4)) * 100) / 100; setFireRate(v); setFireRateDraft(""); setFireRateFocused(false); }}
                      style={{ ...S.inputBase, ...S.inputGreen, width: 60, borderRadius: 6, padding: "2px 6px", textAlign: "right", outline: "none" }} />
                    <span style={{ fontSize: 14, color: "#6ee7b7" }}>%</span>
                  </div>
                </div>
                <input type="range" min={1} max={10} step={0.1} value={fireRate}
                  onChange={e => setFireRate(Number(e.target.value))}
                  style={{ width: "100%", accentColor: "#10b981" }} />
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#047857", marginTop: 4 }}>
                  <span>3%（安全志向）</span><span>4%（基本ルール）</span><span>5〜6%（海外移住等）</span>
                </div>
                <div style={{ marginTop: 6, fontSize: 10, color: "#4b5563", lineHeight: 1.7 }}>
                  <span style={{ color: fireRate <= 3.5 ? "#6ee7b7" : "#4b5563" }}>3〜3.5%：超長期・安全重視</span>　
                  <span style={{ color: fireRate > 3.5 && fireRate <= 4.5 ? "#6ee7b7" : "#4b5563" }}>4%：トリニティスタディ基準</span>　
                  <span style={{ color: fireRate > 4.5 ? "#6ee7b7" : "#4b5563" }}>5〜6%：物価の安い国への移住前提</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 設定パネル */}
      <div style={{ background: "rgba(16,185,129,0.03)", border: "1px solid rgba(16,185,129,0.1)", borderRadius: 16, padding: 24, marginBottom: 22 }}>
        {/* フェーズテーブル */}
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 10, color: "#6ee7b7", letterSpacing: 2, marginBottom: 6 }}>積み立てフェーズ設定</div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4, flexWrap: "wrap" }}>
            <button onClick={() => setUseStartDate(v => !v)} style={{
              background: useStartDate ? "rgba(16,185,129,0.15)" : "rgba(16,185,129,0.04)",
              border: `1px solid ${useStartDate ? "rgba(16,185,129,0.5)" : "rgba(16,185,129,0.15)"}`,
              borderRadius: 8, padding: "4px 12px", cursor: "pointer",
              color: useStartDate ? "#6ee7b7" : "#4b5563", fontSize: 11, fontWeight: useStartDate ? 700 : 400,
            }}>開始年月・年齢 {useStartDate ? "ON" : "OFF"}</button>
            <button onClick={() => setShowBonus(b => !b)} style={{ background: showBonus ? "rgba(251,191,36,0.15)" : "rgba(16,185,129,0.08)", border: `1px solid ${showBonus ? "rgba(251,191,36,0.4)" : "rgba(16,185,129,0.2)"}`, borderRadius: 6, color: showBonus ? "#fbbf24" : "#6ee7b7", fontSize: 11, padding: "4px 12px", cursor: "pointer" }}>💰 ボーナス {showBonus ? "非表示" : "表示"}</button>
          </div>

          {/* 開始年月・年齢 */}
          <div style={{ marginBottom: 10 }}>
            <div style={{ marginBottom: 4 }}>
              {!useStartDate && <div style={{ fontSize: 10, color: "#6b7280", marginTop: 4 }}>ONにすると開始年月・年齢を設定でき、年別推移が西暦年表示になります。</div>}
            </div>
            {useStartDate && (<>
              <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
                <input type="number" min={2000} max={2100}
                  value={startYearFocused ? (startYearDraft === null ? "" : startYearDraft) : startYear}
                  onFocus={() => { setStartYearFocused(true); setStartYearDraft(String(startYear)); }}
                  onChange={e => setStartYearDraft(e.target.value)}
                  onBlur={e => {
                    const v = e.target.value === "" ? new Date().getFullYear() : Math.min(2100, Math.max(2000, Math.floor(Number(e.target.value)) || new Date().getFullYear()));
                    setStartYear(v); setStartYearDraft(""); setStartYearFocused(false);
                  }}
                  style={{ ...S.inputBase, ...S.inputGreen, width: 80, borderRadius: 6, padding: "4px 6px", textAlign: "right", outline: "none" }} />
                <span style={{ fontSize: 13, color: "#6ee7b7" }}>年</span>
                <span style={{ fontSize: 12, color: "#4b5563", margin: "0 6px" }}>開始時</span>
                <input type="number" min={0} max={100}
                  value={startAgeFocused ? (startAgeDraft === null ? "" : startAgeDraft) : startAge}
                  onFocus={() => { setStartAgeFocused(true); setStartAgeDraft(startAge === 0 ? "" : String(startAge)); }}
                  onChange={e => setStartAgeDraft(e.target.value)}
                  onBlur={e => { const v = e.target.value === "" ? 0 : Math.max(0, Math.min(100, Math.floor(Number(e.target.value)) || 0)); setStartAge(v); setStartAgeDraft(""); setStartAgeFocused(false); }}
                  style={{ ...S.inputBase, ...S.inputGreen, width: 60, borderRadius: 6, padding: "4px 6px", textAlign: "right", outline: "none" }} />
                <span style={{ fontSize: 13, color: "#6ee7b7" }}>歳</span>
              </div>
              <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 6, lineHeight: 1.7 }}>
                年齢を設定する場合は、開始する年になる年齢を入力してください。
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 6 }}>
                {[1,2,3,4,5,6,7,8,9,10,11,12].map(m => (
                  <button key={m} onClick={() => setStartMonth(m)} style={{
                    background: startMonth === m ? "rgba(16,185,129,0.25)" : "transparent",
                    border: `1px solid ${startMonth === m ? "#6ee7b7" : "rgba(16,185,129,0.2)"}`,
                    color: startMonth === m ? "#6ee7b7" : "#4b5563",
                    fontSize: 12, fontWeight: startMonth === m ? 700 : 400,
                    borderRadius: 4, padding: "4px 7px", cursor: "pointer", minWidth: 34,
                  }}>{m}月</button>
                ))}
              </div>
            </>)}
          </div>

          <div style={{ fontSize: 13, fontWeight: 700, color: "#a7f3d0", marginBottom: 10 }}>
            総期間 {periodLabel(Math.floor(totalMonths/12), totalMonths%12)}
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ color: "#6ee7b7", fontSize: 10 }}>
                  <th style={{ textAlign: "left", padding: "6px 8px", fontWeight: 400, minWidth: 120 }}>フェーズ名</th>
                  <th style={{ textAlign: "left", padding: "6px 8px", fontWeight: 400 }}>入金方法</th>
                  <th style={{ textAlign: "right", padding: "6px 8px", fontWeight: 400 }}>入金額<br /><span style={{ color: "#4b5563" }}>（万円）</span></th>
                  {showBonus && <>
                    <th style={{ textAlign: "right", padding: "6px 8px", fontWeight: 400, color: "#fbbf24" }}>ボーナス<br /><span style={{ color: "#78350f" }}>（万円/回）</span></th>
                    <th style={{ textAlign: "right", padding: "6px 8px", fontWeight: 400, color: "#fbbf24" }}>回数<br /><span style={{ color: "#78350f" }}>（年）</span></th>
                  </>}
                  <th style={{ textAlign: "right", padding: "6px 8px", fontWeight: 400 }}>年</th>
                  <th style={{ textAlign: "right", padding: "6px 8px", fontWeight: 400 }}>ヶ月</th>
                  <th style={{ textAlign: "center", padding: "6px 8px", fontWeight: 400, color: "#4b5563", fontSize: 9 }}>合計期間</th>
                  <th style={{ padding: "6px 8px" }}></th>
                </tr>
              </thead>
              <tbody>
                {phases.map((phase, i) => (
                  <tr key={phase.id} style={{ borderTop: "1px solid rgba(16,185,129,0.08)", background: i % 2 === 0 ? "rgba(16,185,129,0.02)" : "transparent" }}>
                    <td style={{ padding: "7px 8px" }}>
                      <div style={{ width: 120, overflowX: "auto", whiteSpace: "nowrap" }}>
                        <input value={phase.label} onChange={e => updatePhase(phase.id, "label", e.target.value)}
                          style={{ background: "transparent", border: "none", borderBottom: "1px solid rgba(16,185,129,0.2)", color: "#e2f5ec", fontSize: 16, outline: "none", padding: "2px 4px", whiteSpace: "nowrap" }} />
                      </div>
                    </td>
                    <td style={{ padding: "7px 8px" }}>
                      <select value={phase.method || "monthly"} onChange={e => updatePhase(phase.id, "method", e.target.value)}
                        style={{ ...numInput(130), textAlign: "left" }}>
                        {CONTRIB_METHODS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                      </select>
                    </td>
                    <td style={{ padding: "7px 8px", textAlign: "right" }}>
                      <input type="number" min={0} max={3600}
                        value={getDraft(phase.id, "amount", phase.amount)}
                        onFocus={() => onFocusNum(phase.id, "amount", phase.amount)}
                        onChange={e => onChangeNum(phase.id, "amount", e.target.value)}
                        onBlur={e => onBlurNum(phase.id, "amount", e.target.value, 0)}
                        style={numInput(76)} />
                    </td>
                    {showBonus && <>
                      <td style={{ padding: "7px 8px", textAlign: "right" }}>
                        <input type="number" min={0} max={500}
                          value={getDraft(phase.id, "bonusPerTime", phase.bonusPerTime || 0)}
                          onFocus={() => onFocusNum(phase.id, "bonusPerTime", phase.bonusPerTime || 0)}
                          onChange={e => onChangeNum(phase.id, "bonusPerTime", e.target.value)}
                          onBlur={e => onBlurNum(phase.id, "bonusPerTime", e.target.value, 0)}
                          style={{ ...numInput(70), color: "#fbbf24", border: "1px solid rgba(251,191,36,0.3)", background: "rgba(251,191,36,0.08)" }} />
                      </td>
                      <td style={{ padding: "7px 8px", textAlign: "right" }}>
                        <select value={phase.bonusTimes ?? 0} onChange={e => updatePhase(phase.id, "bonusTimes", e.target.value)}
                          style={{ ...numInput(60), color: "#fbbf24", border: "1px solid rgba(251,191,36,0.3)", background: "rgba(251,191,36,0.08)" }}>
                          <option value={0}>0回</option>
                          <option value={1}>1回</option>
                          <option value={2}>2回</option>
                        </select>
                      </td>
                    </>}
                    <td style={{ padding: "7px 8px", textAlign: "right" }}>
                      <input type="number" min={0} max={99}
                        value={getDraft(phase.id, "years", phase.years ?? 0)}
                        onChange={e => onChangeNum(phase.id, "years", e.target.value)}
                        onFocus={() => onFocusNum(phase.id, "years", phase.years ?? 0)}
                        onBlur={e => onBlurNum(phase.id, "years", e.target.value, 0)}
                        style={numInput(56)} />
                    </td>
                    <td style={{ padding: "7px 8px", textAlign: "right" }}>
                      <input type="number" min={0} max={11}
                        value={getDraft(phase.id, "months", phase.months ?? 0)}
                        onChange={e => onChangeNum(phase.id, "months", e.target.value)}
                        onFocus={() => onFocusNum(phase.id, "months", phase.months ?? 0)}
                        onBlur={e => onBlurNum(phase.id, "months", e.target.value, 0)}
                        style={numInput(56)} />
                    </td>
                    <td style={{ padding: "7px 8px", textAlign: "center", color: "#6b7280", fontSize: 10 }}>
                      {periodLabel(phase.years || 0, phase.months || 0)}
                    </td>
                    <td style={{ padding: "7px 8px", textAlign: "center" }}>
                      <button onClick={() => removePhase(phase.id)} style={{ background: "none", border: "none", color: "#ef4444", cursor: "pointer", fontSize: 15, opacity: 0.6 }}>×</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <button onClick={addPhase} style={{ marginTop: 12, background: "rgba(16,185,129,0.07)", border: "1px dashed rgba(16,185,129,0.3)", borderRadius: 8, color: "#6ee7b7", fontSize: 12, padding: "8px 20px", cursor: "pointer", width: "100%", letterSpacing: 2 }}>＋ フェーズを追加</button>
        <div style={{ marginTop: 10, fontSize: 10, color: "#6b7280", lineHeight: 1.8 }}>
          💡 入金額は1回あたりの金額を入力してください。
        </div>

        {/* 放置期間 */}
        <div style={{ background: "rgba(167,139,250,0.07)", border: "1px solid rgba(167,139,250,0.2)", borderRadius: 10, padding: "16px 18px", marginTop: 18 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <div>
              <div style={{ fontSize: 13, color: "#c4b5fd" }}>🌙 放置期間</div>
              <div style={{ fontSize: 10, color: "#7c3aed", marginTop: 2, whiteSpace: "nowrap" }}>（積み立て終了後）</div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "nowrap", whiteSpace: "nowrap" }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 2 }}>
                <input type="number" min={0} max={600}
                  value={coastDraft === null ? "" : coastDraft !== "" ? coastDraft : Math.floor(coastMonths / 12)}
                  onFocus={() => { if (Math.floor(coastMonths / 12) === 0) setCoastDraft(null); }}
                  onChange={e => setCoastDraft(e.target.value)}
                  onBlur={e => { const y = e.target.value === "" ? 0 : Math.max(0, Math.floor(Number(e.target.value)) || 0); setCoastMonths(y * 12 + (coastMonths % 12)); setCoastDraft(""); }}
                  style={{ ...S.inputBase, ...S.inputPurple, fontWeight: 900, width: 56, borderRadius: 6, padding: "2px 6px", textAlign: "right", outline: "none" }} />
                <span style={{ fontSize: 13, color: "#a78bfa" }}>年</span>
              </div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 2 }}>
                <input type="number" min={0} max={11}
                  value={coastMonthDraft === null ? "" : coastMonthDraft !== "" ? coastMonthDraft : coastMonths % 12}
                  onFocus={() => { if (coastMonths % 12 === 0) setCoastMonthDraft(null); }}
                  onChange={e => setCoastMonthDraft(e.target.value)}
                  onBlur={e => { const m = e.target.value === "" ? 0 : Math.min(11, Math.max(0, Math.floor(Number(e.target.value)) || 0)); setCoastMonths(Math.floor(coastMonths / 12) * 12 + m); setCoastMonthDraft(""); }}
                  style={{ ...S.inputBase, ...S.inputPurple, fontWeight: 900, width: 50, borderRadius: 6, padding: "2px 6px", textAlign: "right", outline: "none" }} />
                <span style={{ fontSize: 13, color: "#a78bfa" }}>ヶ月</span>
              </div>
            </div>
          </div>
          {coastMonths > 0 && summary.balanceAtCoastStart > 0 && (
            <div style={{ fontSize: 11, color: "#c4b5fd", fontWeight: 700 }}>
              放置開始時 {formatMan(summary.balanceAtCoastStart)} → {periodLabel(Math.floor(coastMonths/12), coastMonths%12)}後 {formatMan(summary.finalBalance)}（＋{formatMan(summary.coastGrowth)}）
            </div>
          )}
        </div>
      
</div>
        {/* 年間利回り */}
        <div style={{ marginBottom: 22 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <span style={{ fontSize: 13, color: "#a7f3d0" }}>年間利回り（税引前）</span>
            <div style={{ display: "flex", alignItems: "baseline", gap: 2 }}>
              <input type="number" min={0} max={15} step={0.5}
                {...scalarInput(annualReturn, returnDraft, setReturnDraft, setAnnualReturn, returnFocused, setReturnFocused, 0, 15)}
                style={{ ...S.inputBase, ...S.inputGreen, fontWeight: 900, width: 70, borderRadius: 6, padding: "2px 6px", textAlign: "right", outline: "none" }} />
              <span style={{ fontSize: 14, color: "#6ee7b7" }}>%</span>
            </div>
          </div>
          <input type="range" min={0} max={15} step={0.5} value={annualReturn}
            onChange={e => { slideReturn(Number(e.target.value)); setReturnDraft(""); }}
            onMouseUp={e => setAnnualReturn(Number(e.target.value))}
            onTouchEnd={e => setAnnualReturn(Number(e.target.value))}
            style={{ width: "100%", accentColor: "#10b981" }} />
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#047857", marginTop: 4 }}>
            <span>5〜7%（オルカン目安）</span><span>7〜10%（S&amp;P500目安）</span>
          </div>
        </div>

        {/* 想定リスク */}
        <div style={{ marginBottom: 22 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <div>
              <div style={{ fontSize: 13, color: "#a7f3d0" }}>想定リスク</div>
              <div style={{ fontSize: 10, color: "#6b7280", marginTop: 2 }}>0%の場合はリスク非表示、入力するとグラフに<br />3本線で表示されます。</div>
            </div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 2 }}>
              <input type="number" min={0} max={50} step={0.5}
                {...scalarInput(annualRisk, riskDraft, setRiskDraft, setAnnualRisk, riskFocused, setRiskFocused, 0, 50)}
                style={{ background: "rgba(251,191,36,0.1)", border: "1px solid rgba(251,191,36,0.3)", color: "#fbbf24", fontSize: 16, fontWeight: 900, width: 70, borderRadius: 6, padding: "2px 6px", textAlign: "right", outline: "none" }} />
              <span style={{ fontSize: 14, color: "#fbbf24" }}>%</span>
            </div>
          </div>
          <input type="range" min={0} max={50} step={0.5} value={annualRisk}
            onChange={e => { slideRisk(Number(e.target.value)); setRiskDraft(""); }}
            onMouseUp={e => setAnnualRisk(Number(e.target.value))}
            onTouchEnd={e => setAnnualRisk(Number(e.target.value))}
            style={{ width: "100%", accentColor: "#f59e0b" }} />
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#78350f", marginTop: 4 }}>
            <span>オルカン・S&amp;P500：15〜20%</span><span>先進国株式：15〜17%</span>
          </div>
          <div style={{ fontSize: 10, color: "#78350f", marginTop: 2 }}>新興国株式：20〜25%</div>
          {annualRisk > 0 && (
            <div style={{ marginTop: 8, fontSize: 11, color: "#fbbf24", lineHeight: 1.8 }}>
              最良ケース：年率 <strong>{annualReturn + annualRisk}%</strong>　／　中央値：年率 <strong>{annualReturn}%</strong>　／　最悪ケース：年率 <strong>{annualReturn - annualRisk}%</strong>
            </div>
          )}
        </div>

        {/* インフレ率・開始月 */}
        <div style={{ display: "flex", gap: 16, marginBottom: 22, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <div>
                <div style={{ fontSize: 13, color: "#a7f3d0" }}>インフレ率</div>
                <div style={{ fontSize: 10, color: "#6b7280", marginTop: 2 }}>実質利回り = 年利 − インフレ率</div>
              </div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 2 }}>
                <input type="number" min={0} max={10} step={0.1}
                  {...scalarInput(inflationRate, inflationDraft, setInflationDraft, setInflationRate, inflationFocused, setInflationFocused, 0, 10)}
                  style={{ ...S.inputBase, ...S.inputRed, fontWeight: 900, width: 70, borderRadius: 6, padding: "2px 6px", textAlign: "right", outline: "none" }} />
                <span style={{ fontSize: 14, color: "#f87171" }}>%</span>
              </div>
            </div>
            <input type="range" min={0} max={10} step={0.1} value={inflationRate}
              onChange={e => { slideInflation(Number(e.target.value)); setInflationDraft(""); }}
              onMouseUp={e => setInflationRate(Number(e.target.value))}
              onTouchEnd={e => setInflationRate(Number(e.target.value))}
              style={{ width: "100%", accentColor: "#ef4444" }} />
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#7f1d1d", marginTop: 4 }}>
              <span>2%（日本目標）</span>
            </div>
            {inflationRate > 0 && (
              <div style={{ marginTop: 6, fontSize: 11, color: "#f87171" }}>
                実質利回り：<strong>{(annualReturn - inflationRate).toFixed(1)}%</strong>
                {annualRisk > 0 && <>　最良：<strong>{(annualReturn + annualRisk - inflationRate).toFixed(1)}%</strong>　最悪：<strong>{(annualReturn - annualRisk - inflationRate).toFixed(1)}%</strong></>}
              </div>
            )}
          </div>
        </div>


      {/* NISA超過バナー */}
      {hasTaxable && (
        <div style={{ background: "rgba(239,68,68,0.05)", border: "1px solid rgba(239,68,68,0.18)", borderRadius: 10, padding: "10px 16px", marginBottom: 18, fontSize: 11, color: "#fca5a5", lineHeight: 1.9 }}>
          <strong style={{ color: "#f87171" }}>⚠️ NISA枠超過 → 特定口座で運用</strong>　超過分は特定口座扱い。売却時に運用益の <strong>20.315%</strong> が課税されます。
        </div>
      )}

      {/* グラフ */}
      {/* ========== 広告2: シミュレーション設定とグラフの間 ==========
      <ins className="adsbygoogle"
        style={{ display: "block" }}
        data-ad-client="ca-pub-xxxxxxxxxx"
        data-ad-slot="xxxxxxxxxx"
        data-ad-format="auto"
        data-full-width-responsive="true" />
      ============================================================== */}
      <div style={{ background: "rgba(16,185,129,0.03)", border: "1px solid rgba(16,185,129,0.1)", borderRadius: 16, padding: "22px 8px 14px", marginBottom: 22 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16, marginLeft: 16, marginBottom: 14, flexWrap: "wrap" }}>
          <div style={{ fontSize: 10, color: "#6ee7b7", letterSpacing: 3 }}>資産推移グラフ（年次）</div>
          {annualRisk > 0 && (
            <div style={{ display: "flex", gap: 14, fontSize: 10 }}>
              <span style={{ color: "#60a5fa" }}>▲ 最良（+{annualRisk}%）</span>
              <span style={{ color: "#6ee7b7" }}>━ 中央値</span>
              <span style={{ color: "#f87171" }}>▼ 最悪（-{annualRisk}%）</span>
            </div>
          )}
          {coastStartMonth && <div style={{ fontSize: 10, color: "#a78bfa" }}>🌙 放置期間</div>}
        </div>
        <ResponsiveContainer width="100%" height={300}>
          <AreaChart data={chartData} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="gBest" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#60a5fa" stopOpacity={0.25} /><stop offset="100%" stopColor="#60a5fa" stopOpacity={0.02} /></linearGradient>
              <linearGradient id="gMid"  x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#6ee7b7" stopOpacity={0.35} /><stop offset="100%" stopColor="#6ee7b7" stopOpacity={0.02} /></linearGradient>
              <linearGradient id="gWorst" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#f87171" stopOpacity={0.2}  /><stop offset="100%" stopColor="#f87171" stopOpacity={0.02} /></linearGradient>
              <linearGradient id="gCost"  x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#475569" stopOpacity={0.4}  /><stop offset="100%" stopColor="#475569" stopOpacity={0.02} /></linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(16,185,129,0.07)" />
            <XAxis dataKey="actualYear" stroke="#10b981" tick={{ fontSize: 11, fill: "#6ee7b7" }} tickFormatter={v => `${v}年`} />
            <YAxis stroke="#10b981" tick={{ fontSize: 11, fill: "#6ee7b7" }} tickFormatter={v => v >= 10000 ? `${(v/10000).toFixed(0)}億` : `${v}万`} />
            <Tooltip content={<CustomTooltip coastStartMonth={coastStartMonth} />} />
            <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />
            {coastStartMonth && <ReferenceLine x={coastStartMonth} stroke="#a78bfa" strokeDasharray="5 3" strokeWidth={1.5} label={{ value: "🌙 放置開始", position: "top", fontSize: 10, fill: "#a78bfa" }} />}
            <Area type="monotone" dataKey="投資元本" stroke="#64748b" strokeWidth={1.5} fill="url(#gCost)" strokeDasharray="4 2" />
            {annualRisk > 0 && <Area type="monotone" dataKey="最良ケース" stroke="#60a5fa" strokeWidth={1.5} fill="url(#gBest)" strokeDasharray="3 2" dot={false} />}
            <Area type="monotone" dataKey="中央値" stroke="#6ee7b7" strokeWidth={2.5} fill="url(#gMid)" dot={false} />
            {annualRisk > 0 && <Area type="monotone" dataKey="最悪ケース" stroke="#f87171" strokeWidth={1.5} fill="url(#gWorst)" strokeDasharray="3 2" dot={false} />}
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* 年別テーブル */}
      <div style={{ background: "rgba(16,185,129,0.03)", border: "1px solid rgba(16,185,129,0.1)", borderRadius: 16, padding: 24, marginBottom: 22 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14, flexWrap: "wrap", gap: 8 }}>
          <div>
            <div style={{ fontSize: 10, color: "#6ee7b7", letterSpacing: 3, marginBottom: 4 }}>年別推移（各年末時点の資産額・税引後手取りを表示　概算税額は全額売却した場合の試算）</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#a7f3d0" }}>総期間 {periodLabel(Math.floor(totalMonths/12), totalMonths%12)}</div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
            <div style={{ display: "flex", gap: 4 }}>
              <button onClick={() => setShowDetail(false)} style={{ background: !showDetail ? "rgba(16,185,129,0.25)" : "transparent", border: `2px solid ${!showDetail ? "#6ee7b7" : "rgba(16,185,129,0.2)"}`, borderRadius: 8, color: !showDetail ? "#6ee7b7" : "#4b5563", fontSize: 13, fontWeight: !showDetail ? 700 : 400, padding: "7px 16px", cursor: "pointer" }}>簡易表示</button>
              <button onClick={() => setShowDetail(true)}  style={{ background:  showDetail ? "rgba(16,185,129,0.25)" : "transparent", border: `2px solid ${ showDetail ? "#6ee7b7" : "rgba(16,185,129,0.2)"}`, borderRadius: 8, color:  showDetail ? "#6ee7b7" : "#4b5563", fontSize: 13, fontWeight:  showDetail ? 700 : 400, padding: "7px 16px", cursor: "pointer" }}>詳細表示</button>
            </div>
            <div style={{ fontSize: 10, color: "#4b5563", lineHeight: 1.6 }}>
              {showDetail
                ? "入金額・NISA口座残高・特定口座・概算税額・NISA残枠を追加表示中です。"
                : "詳細表示に切り替えると、入金額・NISA口座・特定口座・概算税額・NISA残枠も確認できます。"}
            </div>
          </div>
        </div>
        <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 8, lineHeight: 1.7 }}>
          NISA残枠がある年の行に <span style={{ color: "#fbbf24" }}>満額調整</span> ボタンが表示されます。押すとその年からNISA枠を使い切るための増額プランを自動計算してフェーズに反映できます。
        </div>
        <div style={{ overflowX: "auto", maxHeight: 400, overflowY: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, whiteSpace: "nowrap" }}>
            <thead style={{ position: "sticky", top: 0, background: "#050e09", zIndex: 1 }}>
              <tr style={{ color: "#6ee7b7", fontSize: 10 }}>
                {(showDetail
                  ? ["年", ...(useStartDate && startAge > 0 ? ["年齢"] : []), "入金額","元本累計","NISA口座","特定口座","税引前合計","▲ 概算税額","税引後手取り","NISA残枠",""]
                  : ["年", ...(useStartDate && startAge > 0 ? ["年齢"] : []), "元本累計","税引前合計","税引後手取り",""]
                ).map(h => (
                  <th key={h} style={{ padding: "7px 10px", textAlign: "right", fontWeight: 400, borderBottom: "1px solid rgba(16,185,129,0.15)" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {chartData.map((row, i) => (
                <tr key={i} style={{ borderBottom: "1px solid rgba(16,185,129,0.04)", background: row.isCoast ? "rgba(167,139,250,0.04)" : row.nisaFull && row.特定口座 > 0 ? "rgba(245,158,11,0.04)" : i % 2 === 0 ? "rgba(16,185,129,0.015)" : "transparent" }}>
                  <td style={{ padding: "5px 10px", textAlign: "right", color: row.isCoast ? "#a78bfa" : "#6ee7b7", fontWeight: 700 }}>{useStartDate ? (row.actualYear ?? row.x) : `${row.x}年目`}</td>
                  {useStartDate && startAge > 0 && <td style={{ padding: "5px 10px", textAlign: "right", color: "#6b7280", fontSize: 10 }}>{row.actualYear ? `${startAge + (row.actualYear - startYear)}歳` : "—"}</td>}
                  {showDetail && <>
                    <td style={{ padding: "5px 10px", textAlign: "right", color: "#a7f3d0" }}>{row.isCoast ? "—" : `${row.perAmount ?? 0}万`}</td>
                  </>}
                  <td style={S.td}>{formatMan(row.投資元本)}</td>
                  {showDetail && <>
                    <td style={{ padding: "5px 10px", textAlign: "right", color: row.isCoast ? "#818cf8" : "#6ee7b7" }}>{formatMan(row.NISA口座)}</td>
                    <td style={{ padding: "5px 10px", textAlign: "right", color: row.特定口座 > 0 ? "#f59e0b" : "#6b7280" }}>{row.特定口座 > 0 ? formatMan(row.特定口座) : "—"}</td>
                  </>}
                  <td style={{ padding: "5px 10px", textAlign: "right", fontWeight: 700, color: row.isCoast ? "#c4b5fd" : undefined }}>{formatMan(row.資産総額_税引前)}</td>
                  {showDetail && (
                    <td style={{ padding: "5px 10px", textAlign: "right", color: row.税額 > 0 ? "#fca5a5" : "#6b7280" }}>{row.税額 > 0 ? `▲ ${formatMan(row.税額)}` : "—"}</td>
                  )}
                  <td style={{ padding: "5px 10px", textAlign: "right", color: "#fbbf24", fontWeight: 700 }}>{formatMan(row.資産総額_税引後)}</td>
                  {showDetail && (
                    <td style={{ padding: "5px 10px", textAlign: "right", color: row.NISA残枠 <= 0 ? "#34d399" : "#6b7280", fontSize: 10 }}>{row.NISA残枠 <= 0 ? "満額🎉" : formatMan(row.NISA残枠)}</td>
                  )}
                  <td style={{ padding: "5px 6px", textAlign: "center" }}>
                    {!row.isCoast && row.NISA残枠 > 0 && (
                      <button onClick={() => {
                        const proposal = calcFillProposal(row, 1);
                        setFillPanel({ row, years: 1, proposal, selectedMethod: proposal[0]?.method });
                      }} style={{ background: "rgba(251,191,36,0.1)", border: "1px solid rgba(251,191,36,0.3)", borderRadius: 4, color: "#fbbf24", fontSize: 10, padding: "2px 7px", cursor: "pointer", whiteSpace: "nowrap" }}>満額調整</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* 満額調整パネル */}
      {fillPanel && (
        <div style={{ background: "rgba(251,191,36,0.06)", border: "1px solid rgba(251,191,36,0.3)", borderRadius: 16, padding: 24, marginBottom: 22 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: "#fbbf24" }}>🎯 NISA満額調整</div>
              <div style={{ fontSize: 11, color: "#78350f", marginTop: 4 }}>{fillPanel.row.x}年目末時点のNISA残枠：<strong style={{ color: "#fbbf24" }}>{formatMan(fillPanel.row.NISA残枠)}</strong></div>
            </div>
            <button onClick={() => setFillPanel(null)} style={{ background: "none", border: "none", color: "#6b7280", fontSize: 18, cursor: "pointer" }}>×</button>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
            <span style={{ fontSize: 13, color: "#a7f3d0" }}>何年で満額にする？</span>
            <input type="number" min={1} max={30}
              value={fillYearsFocused ? (fillYearsDraft === null ? "" : fillYearsDraft) : fillPanel.years}
              onFocus={() => { setFillYearsFocused(true); setFillYearsDraft(fillPanel.years === 0 ? null : String(fillPanel.years)); }}
              onChange={e => { setFillYearsDraft(e.target.value); }}
              onBlur={e => {
                const raw = e.target.value;
                const y = (raw === "" || raw === null) ? 1 : Math.max(1, Math.min(30, Math.floor(Number(raw)) || 1));
                const proposal = calcFillProposal(fillPanel.row, y);
                const next = { ...fillPanel, years: y, proposal, selectedMethod: proposal[0]?.method };
                pushHistory({ fillPanel: next });
                setFillYearsDraft(""); setFillYearsFocused(false);
              }}
              style={{ ...S.inputBase, ...S.inputYellow, width: 60, borderRadius: 6, padding: "4px 8px", textAlign: "right", outline: "none" }} />
            <span style={{ fontSize: 13, color: "#fbbf24" }}>年</span>
          </div>
          {fillPanel.proposal.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11, color: "#78350f", marginBottom: 8 }}>入金方法を選択</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {fillPanel.proposal.map(p => (
                  <button key={p.method} onClick={() => setFillPanel(f => ({ ...f, selectedMethod: p.method }))}
                    style={{ background: fillPanel.selectedMethod === p.method ? "rgba(251,191,36,0.2)" : "rgba(251,191,36,0.05)", border: `2px solid ${fillPanel.selectedMethod === p.method ? "#fbbf24" : "rgba(251,191,36,0.2)"}`, borderRadius: 8, padding: "10px 16px", cursor: "pointer", textAlign: "left", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: 13, color: "#fbbf24", fontWeight: fillPanel.selectedMethod === p.method ? 700 : 400 }}>{p.label}</span>
                    <span style={{ fontSize: 13, color: "#fff", fontWeight: 700 }}>
                      {p.method === "monthly" ? `月${(fillPanel.row.perAmount || 0) + p.perAmount}万（元${fillPanel.row.perAmount || 0}万 + 増額${p.perAmount}万）`
                        : p.method === "quarterly" ? `1回${(fillPanel.row.perAmount || 0) + p.perAmount}万（元${fillPanel.row.perAmount || 0}万 + 増額${p.perAmount}万）`
                        : `年${(fillPanel.row.perAmount || 0) + p.perAmount}万（元${fillPanel.row.perAmount || 0}万 + 増額${p.perAmount}万）`}
                      　→　{fillPanel.years}年で約{formatMan(p.annualAmount * fillPanel.years)}追加投資
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <button onClick={applyFillPhase} style={{ background: "rgba(251,191,36,0.2)", border: "2px solid #fbbf24", borderRadius: 8, color: "#fbbf24", fontSize: 14, fontWeight: 700, padding: "10px 28px", cursor: "pointer", width: "100%", letterSpacing: 1 }}>✅ この設定でフェーズに反映する</button>
        </div>
      )}

      {/* FIRE結果 */}
      {showFire && fireMonthly > 0 && (
        <div style={{ background: "rgba(16,185,129,0.03)", border: "1px solid rgba(16,185,129,0.1)", borderRadius: 16, padding: 24, marginBottom: 22 }}>
          <div style={{ fontSize: 11, color: "#6ee7b7", letterSpacing: 3, marginBottom: 14 }}>🔥 FIRE目標 達成状況</div>

          {/* 目標年月 */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 13, color: "#a7f3d0", marginBottom: 8 }}>
              {useStartDate ? "何年（何歳）にFIREしたい？" : "何年目にFIREしたい？"}
            </div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
              <input type="number" min={useStartDate ? startYear : 1} max={useStartDate ? 2100 : 100}
                value={fireYearFocused ? (fireYearDraft ?? "") : fireTargetYear}
                onFocus={() => { setFireYearFocused(true); setFireYearDraft(fireTargetYear === 0 ? "" : String(fireTargetYear)); }}
                onChange={e => setFireYearDraft(e.target.value)}
                onBlur={e => {
                  const v = e.target.value === "" ? 0 : Math.max(useStartDate ? startYear : 1, Math.floor(Number(e.target.value)) || 0);
                  setFireTargetYear(v); setFireYearDraft(""); setFireYearFocused(false);
                }}
                style={{ ...S.inputBase, ...S.inputGreen, width: 80, borderRadius: 6, padding: "4px 8px", textAlign: "right", outline: "none" }} />
              <span style={{ fontSize: 14, color: "#6ee7b7" }}>{useStartDate ? "年" : "年目"}</span>
              {useStartDate && <>
                <span style={{ fontSize: 12, color: "#4b5563", margin: "0 6px" }}>または</span>
                <input type="number" min={startAge} max={120}
                  value={fireAgeFocused ? (fireAgeDraft ?? "") : (fireTargetYear > 0 && startAge > 0 ? startAge + (fireTargetYear - startYear) : 0)}
                  onFocus={() => { setFireAgeFocused(true); const age = fireTargetYear > 0 && startAge > 0 ? startAge + (fireTargetYear - startYear) : 0; setFireAgeDraft(age > 0 ? String(age) : ""); }}
                  onChange={e => setFireAgeDraft(e.target.value)}
                  onBlur={e => {
                    const age = Math.floor(Number(e.target.value));
                    if (startAge > 0 && age >= startAge) setFireTargetYear(startYear + (age - startAge));
                    setFireAgeDraft(""); setFireAgeFocused(false);
                  }}
                  style={{ ...S.inputBase, ...S.inputGreen, width: 70, borderRadius: 6, padding: "4px 8px", textAlign: "right", outline: "none" }} />
                <span style={{ fontSize: 14, color: "#6ee7b7" }}>歳</span>
                {startAge === 0 && <span style={{ fontSize: 10, color: "#6b7280" }}>（年齢は開始時年齢を設定すると入力できます。）</span>}
                {startAge > 0 && fireTargetYear > 0 && <span style={{ fontSize: 11, color: "#4b5563" }}>（{startAge + (fireTargetYear - startYear)}歳 = {fireTargetYear}年）</span>}
              </>}
            </div>
            {useStartDate && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {[1,2,3,4,5,6,7,8,9,10,11,12].map(m => (
                <button key={m} onClick={() => setFireTargetMonth(m)} style={{
                  background: fireTargetMonth === m ? "rgba(16,185,129,0.25)" : "transparent",
                  border: `1px solid ${fireTargetMonth === m ? "#6ee7b7" : "rgba(16,185,129,0.2)"}`,
                  color: fireTargetMonth === m ? "#6ee7b7" : "#4b5563",
                  fontSize: 12, fontWeight: fireTargetMonth === m ? 700 : 400,
                  borderRadius: 4, padding: "4px 7px", cursor: "pointer", minWidth: 34,
                }}>{m}月</button>
              ))}
            </div>
            )}
            {fireTargetYear > 0 && (
              <div style={{ marginTop: 6, fontSize: 11, color: "#4b5563" }}>
                {useStartDate ? `${fireTargetYear}年${fireTargetMonth}月を目標に設定` : `${fireTargetYear}年目${fireTargetMonth}月を目標に設定`}
              </div>
            )}
          </div>

          <FireResult
            monthlyAmount={fireMonthly}
            withdrawalRate={fireRate}
            targetYear={fireTargetYear}
            targetMonth={fireTargetMonth}
            chartData={chartData}
            monthlyData={monthlyData}
            useStartDate={useStartDate}
            startYear={startYear}
            state={current}
          />
        </div>
      )}
    </div>
  );
});

// ── メインコンポーネント ──
function AccordionItem({ title, content }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ borderBottom: "1px solid rgba(16,185,129,0.15)" }}>
      <button onClick={() => setOpen(v => !v)} style={{
        width: "100%", textAlign: "left", background: "none", border: "none", cursor: "pointer",
        display: "flex", justifyContent: "space-between", alignItems: "center",
        padding: "14px 0", color: "#6ee7b7", fontSize: 15, fontWeight: 700,
      }}>
        <span>{title}</span>
        <span style={{ fontSize: 18, color: "#6ee7b7", marginLeft: 8 }}>{open ? "▲" : "▼"}</span>
      </button>
      {open && <div style={{ paddingBottom: 16, fontSize: 14, lineHeight: 1.9 }}>{content}</div>}
    </div>
  );
}

export default function NisaSimulator() {
  const [plans, setPlans] = useState([{ id: 1, name: "プランA" }]);
  const [planInitialStates, setPlanInitialStates] = useState({});
  const [planStates, setPlanStates] = useState({}); // 各プランの現在のstate
  const [activeId, setActiveId] = useState(1);
  const [editingId, setEditingId] = useState(null);
  const [editingName, setEditingName] = useState("");
  const planRefs = useRef({});
  const [activeCanUndo, setActiveCanUndo] = useState(false);
  const [activeCanRedo, setActiveCanRedo] = useState(false);
  const [showCompare, setShowCompare] = useState(false);

  const switchPlan = (id) => {
    setActiveId(id);
    const ref = planRefs.current[id];
    setActiveCanUndo(ref?.canUndo ?? false);
    setActiveCanRedo(ref?.canRedo ?? false);
  };

  const addPlan = () => {
    const labels = ["A","B","C","D","E","F","G","H"];
    const name = `プラン${labels[plans.length] || plans.length + 1}`;
    const newId = Date.now();
    setPlans(p => [...p, { id: newId, name }]);
    setActiveId(newId);
    setActiveCanUndo(false);
    setActiveCanRedo(false);
  };

  const copyPlan = (id) => {
    const sourceRef = planRefs.current[id];
    const sourceState = sourceRef?.getCurrentState?.();
    if (!sourceState) return;
    const newId = Date.now();
    setPlanInitialStates(s => ({ ...s, [newId]: sourceState }));
    setPlans(p => [...p, { id: newId, sourceId: id }]);
    setActiveId(newId);
    setActiveCanUndo(false);
    setActiveCanRedo(false);
  };

  const removePlan = (id) => {
    if (plans.length <= 1) return;
    const remaining = plans.filter(p => p.id !== id);
    setPlans(remaining);
    if (activeId === id) setActiveId(remaining[remaining.length - 1].id);
  };

  const startEdit = (plan) => {
    const displayName = plan.name
      ? plan.name
      : `${plans.find(p => p.id === plan.sourceId)?.name ?? "プラン"}（コピー）`;
    setEditingId(plan.id);
    setEditingName(displayName);
  };
  const commitEdit = () => {
    if (editingName.trim()) setPlans(ps => ps.map(p => p.id === editingId ? { ...p, name: editingName.trim(), sourceId: undefined } : p));
    setEditingId(null);
  };

  return (
    <div style={{ minHeight: "100vh", background: "#050e09", fontFamily: "Noto Sans JP, sans-serif", color: "#e2f5ec", padding: "32px 16px" }}>
      <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@300;400;700;900&family=Bebas+Neue&display=swap" rel="stylesheet" />

      {/* ========== 広告1: タイトルの上 ==========
      <ins className="adsbygoogle"
        style={{ display: "block" }}
        data-ad-client="ca-pub-xxxxxxxxxx"
        data-ad-slot="xxxxxxxxxx"
        data-ad-format="auto"
        data-full-width-responsive="true" />
      ========================================= */}

      {/* 戻る・進むボタン（固定・左上） */}
      <div style={{ position: "fixed", top: 12, left: 12, zIndex: 1000, display: "flex", gap: 6 }}>
        <button onClick={() => planRefs.current[activeId]?.undo()} disabled={!activeCanUndo} style={{ display: "flex", alignItems: "center", gap: 5, background: activeCanUndo ? "rgba(16,185,129,0.12)" : "rgba(16,185,129,0.03)", border: `1px solid ${activeCanUndo ? "rgba(16,185,129,0.35)" : "rgba(16,185,129,0.08)"}`, borderRadius: 8, padding: "6px 12px", color: activeCanUndo ? "#6ee7b7" : "#1a3d2a", fontSize: 12, fontWeight: 600, cursor: activeCanUndo ? "pointer" : "default" }}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M10 6H3M3 6L6 3M3 6L6 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
          戻る
        </button>
        <button onClick={() => planRefs.current[activeId]?.redo()} disabled={!activeCanRedo} style={{ display: "flex", alignItems: "center", gap: 5, background: activeCanRedo ? "rgba(16,185,129,0.12)" : "rgba(16,185,129,0.03)", border: `1px solid ${activeCanRedo ? "rgba(16,185,129,0.35)" : "rgba(16,185,129,0.08)"}`, borderRadius: 8, padding: "6px 12px", color: activeCanRedo ? "#6ee7b7" : "#1a3d2a", fontSize: 12, fontWeight: 600, cursor: activeCanRedo ? "pointer" : "default" }}>
          進む
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6H9M9 6L6 3M9 6L6 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </button>
      </div>

      <div style={{ textAlign: "center", marginBottom: 36 }}>
        <div style={{ fontSize: 11, letterSpacing: 6, color: "#10b981", marginBottom: 8 }}>INVESTMENT SIMULATOR</div>
        <h1 style={{ fontFamily: "Bebas Neue, sans-serif", fontSize: "clamp(26px, 6vw, 56px)", letterSpacing: 4, background: "linear-gradient(135deg, #6ee7b7 0%, #10b981 50%, #047857 100%)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", margin: 0, lineHeight: 1.1 }}>NISA 積み立てシミュレーター</h1>
        <p style={{ color: "#6ee7b7", opacity: 0.7, fontSize: 12, marginTop: 8 }}>生涯非課税枠 1,800万円 ／ 年間上限 360万円 ／ 超過分は特定口座（税率 20.315%）</p>
      </div>

      <div style={{ maxWidth: 1060, margin: "0 auto" }}>

        {/* プランタブ */}
        <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 24, flexWrap: "wrap" }}>
          {plans.map(plan => {
            const displayName = plan.name
              ? plan.name
              : `${plans.find(p => p.id === plan.sourceId)?.name ?? "プラン"}（コピー）`;
            return (
            <div key={plan.id} style={{ display: "flex", alignItems: "center", gap: 0 }}>
              {editingId === plan.id ? (
                <input
                  autoFocus value={editingName}
                  onChange={e => setEditingName(e.target.value)}
                  onBlur={commitEdit}
                  onKeyDown={e => { if (e.key === "Enter") commitEdit(); if (e.key === "Escape") setEditingId(null); }}
                  style={{ background: "rgba(16,185,129,0.15)", border: "1px solid #6ee7b7", borderRadius: "8px 0 0 8px", color: "#6ee7b7", fontSize: 16, fontWeight: 700, padding: "8px 12px", outline: "none", width: 100 }}
                />
              ) : (
                <button
                  onClick={() => switchPlan(plan.id)}
                  onDoubleClick={() => startEdit(plan)}
                  style={{
                    background: activeId === plan.id ? "rgba(16,185,129,0.2)" : "rgba(16,185,129,0.05)",
                    border: `1px solid ${activeId === plan.id ? "#6ee7b7" : "rgba(16,185,129,0.2)"}`,
                    borderRight: plans.length > 1 ? "none" : undefined,
                    borderRadius: plans.length > 1 ? "8px 0 0 8px" : 8,
                    color: activeId === plan.id ? "#6ee7b7" : "#4b5563",
                    fontSize: 13, fontWeight: activeId === plan.id ? 700 : 400,
                    padding: "8px 14px", cursor: "pointer",
                  }}>{displayName}</button>
              )}
              {plans.length > 1 && (
                <button onClick={() => removePlan(plan.id)} style={{ background: activeId === plan.id ? "rgba(16,185,129,0.2)" : "rgba(16,185,129,0.05)", border: `1px solid ${activeId === plan.id ? "#6ee7b7" : "rgba(16,185,129,0.2)"}`, borderRadius: "0 8px 8px 0", color: "#6b7280", fontSize: 12, padding: "8px 8px", cursor: "pointer" }}>×</button>
              )}
              {plans.length < 3 && (
                <button onClick={() => copyPlan(plan.id)} title="このプランをコピー" style={{ background: "transparent", border: "none", color: "#4b5563", fontSize: 13, padding: "4px 6px", cursor: "pointer", marginLeft: 2 }}>⧉</button>
              )}
            </div>
            );
          })}
          {plans.length < 3 && (
            <button onClick={addPlan} style={{ background: "rgba(16,185,129,0.07)", border: "1px dashed rgba(16,185,129,0.3)", borderRadius: 8, color: "#6ee7b7", fontSize: 12, padding: "8px 14px", cursor: "pointer" }}>＋ プランを追加</button>
          )}
          <div style={{ fontSize: 10, color: "#6b7280", marginLeft: 4 }}>ダブルタップでプラン名変更　⧉ でコピー　最大3プラン</div>
        </div>

        {/* アクティブなプランのシミュレーター */}
        {plans.map(plan => (
          <div key={plan.id} style={{ display: plan.id === activeId ? "block" : "none" }}>
            <PlanSimulator
              ref={el => { planRefs.current[plan.id] = el; }}
              planName={plan.name ?? `${plans.find(p => p.id === plan.sourceId)?.name ?? "プラン"}（コピー）`}
              isActive={plan.id === activeId}
              initialState={planInitialStates[plan.id]}
              onHistoryChange={(canUndo, canRedo, currentState) => {
                if (plan.id === activeId) {
                  setActiveCanUndo(canUndo);
                  setActiveCanRedo(canRedo);
                }
                if (currentState) setPlanStates(s => ({ ...s, [plan.id]: currentState }));
              }}
            />
          </div>
        ))}

        {/* 比較表トグル＆表示 */}
        {plans.length >= 2 && (
          <div style={{ marginBottom: 40 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 4 }}>
              <button onClick={() => setShowCompare(v => !v)} style={{
                display: "flex", alignItems: "center", gap: 8,
                background: showCompare ? "rgba(16,185,129,0.15)" : "rgba(16,185,129,0.04)",
                border: `1px solid ${showCompare ? "rgba(16,185,129,0.5)" : "rgba(16,185,129,0.15)"}`,
                borderRadius: 8, padding: "8px 16px", cursor: "pointer",
                color: showCompare ? "#6ee7b7" : "#4b5563", fontSize: 13, fontWeight: showCompare ? 700 : 400,
              }}>
                📊 プラン比較表 {showCompare ? "ON" : "OFF"}
              </button>
              <span style={{ fontSize: 10, color: "#6b7280" }}>各プランの最終資産・NISA満額達成年・FIRE目標達成年などを横並びで比較できます。</span>
            </div>
            {showCompare && (
              <div style={{ marginTop: 12, background: "rgba(16,185,129,0.03)", border: "1px solid rgba(16,185,129,0.12)", borderRadius: 16, padding: 20, overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, whiteSpace: "nowrap" }}>
                  <thead>
                    <tr style={{ color: "#6ee7b7", fontSize: 10 }}>
                      <th style={{ padding: "7px 10px", textAlign: "left", fontWeight: 400, borderBottom: "1px solid rgba(16,185,129,0.15)" }}>項目</th>
                      {plans.map(plan => {
                        const name = plan.name ?? `${plans.find(p => p.id === plan.sourceId)?.name ?? "プラン"}（コピー）`;
                        return <th key={plan.id} style={{ padding: "7px 10px", textAlign: "right", fontWeight: 700, color: plan.id === activeId ? "#6ee7b7" : "#a7f3d0", borderBottom: "1px solid rgba(16,185,129,0.15)" }}>{name}</th>;
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {(() => {
                      const results = plans.map(plan => {
                        const state = planStates[plan.id];
                        if (!state) return { plan, result: null, state: null };
                        return { plan, result: runSim(state), state };
                      });
                      const rows = [
                        { label: "投資期間", fn: r => {
                          if (!r.state) return "—";
                          const months = r.state.phases.reduce((s, p) => s + (p.years || 0) * 12 + (p.months || 0), 0) + (r.state.coastMonths || 0);
                          return periodLabel(Math.floor(months / 12), months % 12);
                        }},
                        { label: "投資元本", fn: r => r.result ? `${r.result.summary.totalInvested.toLocaleString()}万円` : "—" },
                        { label: "最終資産（税引前）", fn: r => r.result ? `${r.result.summary.finalBalance.toLocaleString()}万円` : "—" },
                        { label: "最終資産（税引後）", fn: r => r.result ? `${r.result.summary.afterTaxBalance.toLocaleString()}万円` : "—" },
                        { label: "NISA満額達成", fn: r => {
                          if (!r.result) return "—";
                          const row = r.result.chartData.find(d => d.NISA残枠 <= 0);
                          if (!row) return "未達成";
                          const ageStr = r.state.startAge > 0 ? `（${r.state.startAge + (row.actualYear - r.state.startYear)}歳）` : "";
                          return `${row.actualYear}年${ageStr}`;
                        }},
                      ];
                      return rows.map((row, i) => (
                        <tr key={row.label} style={{ borderBottom: "1px solid rgba(16,185,129,0.04)", background: i % 2 === 0 ? "rgba(16,185,129,0.015)" : "transparent" }}>
                          <td style={{ padding: "7px 10px", color: "#a7f3d0" }}>{row.label}</td>
                          {results.map(r => (
                            <td key={r.plan.id} style={{ padding: "7px 10px", textAlign: "right", color: r.plan.id === activeId ? "#6ee7b7" : "#e2f5ec", fontWeight: 600 }}>
                              {row.fn(r)}
                            </td>
                          ))}
                        </tr>
                      ));
                    })()}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* 説明文 */}
        {/* ========== 広告3: 説明文の上 ==========
        <ins className="adsbygoogle"
          style={{ display: "block" }}
          data-ad-client="ca-pub-xxxxxxxxxx"
          data-ad-slot="xxxxxxxxxx"
          data-ad-format="auto"
          data-full-width-responsive="true" />
        ========================================= */}
        <div style={{ marginTop: 40 }}>
          {[
            {
              title: "ライフステージで変化する新NISA積立額に対応",
              content: <>
                <p style={{ color: "#d1d5db", marginBottom: 16 }}>多くの積み立てシミュレーターは、「毎月同じ金額を積み立て続ける」ことを前提として作られています。しかし実際の人生では、投資に回せる金額は常に変化します。就職・昇給・転職・結婚・住宅購入・教育費など、ライフステージによって収入や支出は大きく変わるため、長期間ずっと同じ金額を積み立て続けるケースは多くありません。</p>
                <p style={{ color: "#d1d5db", marginBottom: 16 }}>このシミュレーターは、そうした現実的な資産形成を想定し、フェーズごとに積立額・積立期間・入金方法を変更できるよう設計しています。たとえば、「学生期間は少額積立」「就職後に積立額を増やす」「住宅購入後は一時的に積立額を減らす」といったように、人生設計に合わせたシミュレーションが可能です。</p>
                <p style={{ color: "#d1d5db", marginBottom: 16 }}>また、一般的な毎月積み立てだけでなく、年始一括投資・年度始一括投資・四半期ごとの投資にも対応しています。さらに、通常の積み立てとは別に、ボーナスから追加で投資を行うための「ボーナス設定」にも対応しています。ボーナス投資は年0回・年1回・年2回から選択でき、実際の家計や収入状況に近い形でシミュレーションを行えます。</p>
              </>
            },
            {
              title: "FIREを目指した資産シミュレーション",
              content: <>
                <p style={{ color: "#d1d5db", marginBottom: 16 }}>FIRE（Financial Independence, Retire Early）とは、経済的自立によって早期退職を実現するライフスタイルです。達成に必要なのは「毎月いくら必要か」と「何%で取り崩すか」の2つ。このシミュレーターではその必要資産額を自動計算し、今のプランで何年何月に達成できるかを確認できます。</p>
                <p style={{ color: "#d1d5db", marginBottom: 16 }}>取り崩し率は一般的に4%ルール（トリニティスタディ）が知られていますが、安全重視なら3〜3.5%、物価の安い国への移住を前提にするなら5〜6%と、自分のライフプランに合わせて調整できます。</p>
              </>
            },
            {
              title: "「コーストFIRE」を見据えた放置期間シミュレーション",
              content: <>
                <p style={{ color: "#d1d5db", marginBottom: 16 }}>このシミュレーターでは、「放置期間」の設定にも対応しています。これは、近年注目されている「コーストFIRE」という考え方をシミュレーションするための機能です。コーストFIREとは、若いうちにある程度の資産を形成したあと、追加投資を停止し、その後は保有資産を長期運用していく考え方です。</p>
                <p style={{ color: "#d1d5db", marginBottom: 16 }}>この機能を使うことで、「何歳まで積み立てれば、その後は追加投資なしでもどれくらい資産が成長するのか」を確認できます。積立期間と放置期間を分けて確認できるため、長期運用による複利効果を視覚的に把握しやすくしています。</p>
              </>
            },
            {
              title: "新NISAの「生涯投資枠1,800万円」超過・特定口座の課税自動計算",
              content: <>
                <p style={{ color: "#d1d5db", marginBottom: 16 }}>新NISAでは、生涯非課税枠1,800万円、年間投資上限360万円が設定されています。しかし、長期間積み立てを続ける場合、NISA枠を使い切るケースも少なくありません。</p>
                <p style={{ color: "#d1d5db", marginBottom: 16 }}>一般的なシミュレーターでは、NISA枠を超えた場合の税金まで考慮されていないことがありますが、このツールでは非課税枠を自動で追跡し、超過分は特定口座として自動計算します。特定口座で発生した運用益には20.315%の税金がかかるため、税引前資産だけでなく、概算税額や税引後資産も表示されます。</p>
                <p style={{ color: "#d1d5db", marginBottom: 16 }}>これにより、「NISA枠をいつ使い切るか」「超過後にどれくらい税金が発生するか」を含めて確認できます。単純な理想値だけではなく、課税まで考慮した、より現実的な資産形成シミュレーションを目的としています。</p>
              </>
            },
          ].map((item, i) => <AccordionItem key={i} title={item.title} content={item.content} />)}
          <p style={{ color: "#9ca3af", fontSize: 12, lineHeight: 1.8, borderTop: "1px solid rgba(16,185,129,0.1)", paddingTop: 20, marginTop: 8 }}>
            ※ このシミュレーターは情報提供を目的としており、特定の金融商品への投資を推奨するものではありません。シミュレーション結果は入力値をもとにした参考値であり、実際の運用成績・税額とは異なる場合があります。投資判断はご自身の責任において行ってください。<br />
            ※ 月次複利計算。ボーナスは6月・12月に一括投資。配当・分配金の課税は考慮外。税率 20.315%（所得税15% + 復興特別所得税0.315% + 住民税5%）。
          </p>
        </div>
      </div>
    </div>
  );
}
