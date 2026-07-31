import { evidenceConfidence, scoreForLayer, severity } from "./heatwave-model.js";

const AUDIENCE_CONTEXT = Object.freeze({
  residents: {
    impact: "everyday plans and heat-sensitive people",
    groundLabel: "Soil and plants",
    drySubject: "newly planted and shallow-rooted plants"
  },
  farmers: {
    impact: "field work and crop water needs",
    groundLabel: "Field water",
    drySubject: "the selected crop and its root zone"
  },
  municipal: {
    impact: "local preparedness and public services",
    groundLabel: "Ground and green spaces",
    drySubject: "young trees and heat-sensitive public planting"
  }
});

const LAYER_CONCERN = Object.freeze({
  impact: "the selected decision context",
  heat: "heat exposure",
  dry: "dry soil and water stress",
  wet: "very wet ground and standing water"
});

export const PLAIN_SOURCE_SUMMARY =
  "Based on weather and radar data from Germany's national weather service, soil-water information from the Helmholtz Centre for Environmental Research and the national weather service, and several forecast versions. Exact values, model names, and timestamps are available in Technical detail.";

function roundedTemperature(value) {
  return Number.isFinite(value) ? `${Math.round(value)} °C` : "an unavailable temperature";
}

function heatExplanation(metrics) {
  const feelsLike = roundedTemperature(metrics.apparentMaxC);
  const warmNight = Number.isFinite(metrics.tminC) && metrics.tminC >= 20
    ? " The night may also stay warm, giving people and buildings less time to cool down."
    : "";
  if (metrics.heatScore >= 75) {
    return `Dangerous heat is possible. The hottest part of the day may feel close to ${feelsLike}.${warmNight}`;
  }
  if (metrics.heatScore >= 55) {
    return `It may feel very hot during the warmest hours, reaching about ${feelsLike}. Plan strenuous activity for a cooler time.${warmNight}`;
  }
  if (metrics.heatScore >= 35) {
    return `Afternoon heat may be noticeable, with a peak near ${feelsLike}. Heat-sensitive people may need more breaks and shade.${warmNight}`;
  }
  return `Heat is not the main concern in this view. The warmest period may still feel close to ${feelsLike}.`;
}

function groundExplanation(metrics, audience) {
  const context = AUDIENCE_CONTEXT[audience] || AUDIENCE_CONTEXT.residents;
  if (metrics.wetStressScore >= 75 && metrics.wetStressScore > metrics.dryStressScore) {
    return `The ground may be very wet. Check low spots and poorly drained areas before using or working on them; ${context.drySubject} may be affected by water around the roots.`;
  }
  if (metrics.wetStressScore >= 55 && metrics.wetStressScore > metrics.dryStressScore) {
    return `The ground may stay wetter than usual. Check conditions locally before watering, driving on fields, or scheduling ground work.`;
  }
  if (metrics.dryStressScore >= 75) {
    return `The soil may be extremely dry, including below the surface. Prioritise a local moisture check for ${context.drySubject} before deciding how much water is needed.`;
  }
  if (metrics.dryStressScore >= 55) {
    return `The soil is likely much drier than usual. Check ${context.drySubject} at root depth and focus attention where stress is visible.`;
  }
  if (metrics.dryStressScore >= 35) {
    return `Some dryness is possible. Check below the surface before routine watering because nearby soils can differ.`;
  }
  return "No strong dry-soil or waterlogged-ground signal stands out, but local soil and drainage can still differ.";
}

function rainExplanation(metrics) {
  if (metrics.wetStressScore >= 75) {
    return "Heavy rain or already wet ground could make water collect quickly. Avoid low routes and follow official flood or rain instructions.";
  }
  if (metrics.wetStressScore >= 55) {
    return "Standing water is possible in low or poorly drained places. Check local drains, fields, and access routes before acting.";
  }
  if (metrics.wetStressScore >= 35) {
    return "Some low spots may become wet. Watch places that drain slowly and delay unnecessary watering.";
  }
  if (metrics.dryStressScore >= 55 && Number.isFinite(metrics.precipitationMm) && metrics.precipitationMm < 3) {
    return "Little useful rain is expected, so current dryness is unlikely to ease quickly.";
  }
  if (Number.isFinite(metrics.precipitationMm) && metrics.precipitationMm >= 10) {
    return "A useful amount of rain may fall, although water can still collect in poorly drained places.";
  }
  return "No strong excess-water signal stands out. Check the local forecast because short showers can vary over small distances.";
}

function reviewHeatExplanation(metrics) {
  const level = severity(metrics.heatScore).label.toLowerCase();
  const warmNight = Number.isFinite(metrics.tminC) && metrics.tminC >= 20
    ? " The snapshot also showed a warm night with limited cooling."
    : "";
  return `The snapshot recorded a ${level} heat signal, with the warmest conditions feeling close to ${roundedTemperature(metrics.apparentMaxC)}.${warmNight}`;
}

function reviewGroundExplanation(metrics, audience) {
  const context = AUDIENCE_CONTEXT[audience] || AUDIENCE_CONTEXT.residents;
  if (metrics.wetStressScore >= 55 && metrics.wetStressScore > metrics.dryStressScore) {
    return metrics.wetStressScore >= 75
      ? `The snapshot indicated very wet ground and possible water around the roots of ${context.drySubject}.`
      : `The snapshot indicated wetter-than-usual ground and possible water around the roots of ${context.drySubject}.`;
  }
  if (metrics.dryStressScore >= 75) {
    return `The snapshot indicated extremely dry soil, including below the surface, with possible stress for ${context.drySubject}.`;
  }
  if (metrics.dryStressScore >= 55) {
    return `The snapshot indicated much drier-than-usual soil and possible stress for ${context.drySubject}.`;
  }
  if (metrics.dryStressScore >= 35) {
    return "The snapshot indicated some soil dryness, with likely differences between nearby places.";
  }
  return "The snapshot did not show a strong dry-soil or waterlogged-ground signal, although local conditions may have differed.";
}

function reviewRainExplanation(metrics) {
  if (metrics.wetStressScore >= 75) {
    return "The snapshot indicated heavy rain or very wet ground, with a strong possibility of water collecting in low places.";
  }
  if (metrics.wetStressScore >= 55) {
    return "The snapshot indicated possible standing water in low or poorly drained places.";
  }
  if (metrics.wetStressScore >= 35) {
    return "The snapshot indicated that some low or slowly drained places may have become wet.";
  }
  if (metrics.dryStressScore >= 55 && Number.isFinite(metrics.precipitationMm) && metrics.precipitationMm < 3) {
    return "The snapshot showed little useful rain, so the dry conditions were unlikely to ease quickly.";
  }
  return "The snapshot did not show a strong excess-water signal, though short showers may have varied locally.";
}

export function plainConfidenceLabel(metrics, { stale = false, isRetrospective = false } = {}) {
  if (isRetrospective) return "Past-date view - for review only";
  if (stale) return "Out-of-date data - actions paused";
  const confidence = evidenceConfidence(metrics);
  if (confidence.score >= 78) return "Good basis for planning";
  if (confidence.score >= 58) return "Useful, with some uncertainty";
  return "Early signal - check locally";
}

function confidenceExplanation(metrics, stale) {
  if (stale) {
    return "One or more data updates are too old for current action advice. Use current official and local information instead.";
  }
  const confidence = evidenceConfidence(metrics);
  if (confidence.score >= 78) {
    return "The main inputs are complete and the different forecast versions are reasonably consistent. Conditions can still vary within the selected area.";
  }
  if (confidence.score >= 58) {
    return "This is useful for planning checks, but some observations or forecast versions are less certain. Confirm important decisions locally.";
  }
  return "Treat this as an early signal only. Local observations and current official information are especially important before acting.";
}

export function plainLanguageSummary(metrics, audience, layer, {
  regionName = "This area",
  dateLabel = "the selected date",
  stale = false,
  isRetrospective = false
} = {}) {
  const level = severity(scoreForLayer(metrics, layer)).label.toLowerCase();
  const audienceContext = AUDIENCE_CONTEXT[audience] || AUDIENCE_CONTEXT.residents;
  const concern = layer === "impact" ? audienceContext.impact : LAYER_CONCERN[layer];
  if (isRetrospective) {
    return `${regionName} on ${dateLabel}: a past-date reconstruction showed ${level} concern for ${concern}. It is for review, not current action.`;
  }
  if (stale) {
    return `${regionName} on ${dateLabel}: an out-of-date snapshot shows ${level} concern for ${concern}. Use current data before deciding what to do.`;
  }
  return `${regionName} on ${dateLabel}: ${level} concern for ${concern}. Use the points below to decide what to check next.`;
}

export function plainLanguageSignals(metrics, audience, layer, { stale = false, isRetrospective = false } = {}) {
  const context = AUDIENCE_CONTEXT[audience] || AUDIENCE_CONTEXT.residents;
  const selectedLevel = severity(scoreForLayer(metrics, layer)).label;
  if (stale || isRetrospective) {
    const viewKind = isRetrospective ? "past-date reconstruction" : "out-of-date snapshot";
    return [
      {
        label: "Overall situation",
        text: `${selectedLevel} concern in this ${viewKind}. It is shown for review and is not a current instruction.`
      },
      { label: "Heat", text: reviewHeatExplanation(metrics) },
      { label: context.groundLabel, text: reviewGroundExplanation(metrics, audience) },
      { label: "Rain and standing water", text: reviewRainExplanation(metrics) },
      {
        label: "How sure we are",
        text: isRetrospective
          ? "This reconstruction combines data associated with the selected date. Compare it with archived official information and recorded local conditions."
          : confidenceExplanation(metrics, true)
      }
    ];
  }
  return [
    {
      label: "Overall situation",
      text: `${selectedLevel} concern in the selected view. This is a planning signal, not an official warning or an automatic instruction.`
    },
    { label: "Heat", text: heatExplanation(metrics) },
    { label: context.groundLabel, text: groundExplanation(metrics, audience) },
    { label: "Rain and standing water", text: rainExplanation(metrics) },
    { label: "How sure we are", text: confidenceExplanation(metrics, stale) }
  ];
}

export function plainActionCategory(category) {
  if (category === "Official check") return "Check official advice";
  if (category === "Verify" || category === "Validate") return "Check locally";
  if (category === "Do not automate") return "Human decision required";
  if (category === "Activation gate") return "Before activating";
  if (category === "Retrospective") return "Past-date context";
  if (category === "Very high" || category === "High") return "Priority action";
  if (category === "Moderate") return "Worth doing";
  if (category === "Plan") return "Plan ahead";
  return category;
}

function plainOfficialAdvice({ heatWarningCount = 0, rainWarningCount = 0 } = {}) {
  if (heatWarningCount > 0 && rainWarningCount > 0) {
    return "Official heat and rain warnings are shown for this date. Open their details before acting.";
  }
  if (heatWarningCount > 0) {
    return "An official heat warning is shown for this date. Open its details before acting.";
  }
  if (rainWarningCount > 0) {
    return "An official rain warning is shown for this date. Open its details and check the state flood service before acting.";
  }
  return "Check the current official warning service and, where water may collect or rivers may rise, the state flood service.";
}

export function plainActionsFor(metrics, audience, options = {}) {
  const heatLevel = severity(metrics.heatScore).label;
  const dryLevel = severity(metrics.dryStressScore).label;
  const wetLevel = severity(metrics.wetStressScore).label;
  const actions = [];

  if (audience === "farmers") {
    actions.push({
      category: "Verify",
      text: `Check several representative parts of the field for ${metrics.cropLabel || "the selected crop"}. Look at moisture around the roots, crop symptoms, and recent rain before changing operations.`
    });
    if (metrics.dryStressScore >= 35) {
      actions.push({
        category: dryLevel,
        text: metrics.dryStressScore >= 75
          ? "Inspect vulnerable crop stages and light or shallow soils first. Confirm water availability, local restrictions, and qualified crop advice before a major intervention."
          : metrics.dryStressScore >= 55
            ? "Inspect vulnerable crop stages and lighter soils first. Use field measurements and the farm's own watering threshold before scheduling irrigation."
            : "Check soil and crop symptoms more often, and prepare a field check if dryness increases. This view does not calculate a watering amount."
      });
    }
    if (metrics.wetStressScore >= 35) {
      actions.push({
        category: wetLevel,
        text: metrics.wetStressScore >= 75
          ? "Keep heavy machinery off flooded or waterlogged fields. Put people and livestock safety first and use official flood information before access or drainage decisions."
          : "Inspect low and poorly drained fields before machinery access. Check for standing water, erosion, soil damage, and crop disease symptoms."
      });
    }
    if (metrics.heatScore >= 35) {
      actions.push({
        category: heatLevel,
        text: "Check heat-sensitive crop stages, livestock water and shade, and worker exposure. Move strenuous work to a cooler part of the day where possible."
      });
    }
    actions.push({
      category: "Do not automate",
      text: "Do not change harvest timing, irrigation amount, crop treatment, or another costly operation from HeatLens alone. Confirm conditions in the field and obtain qualified local advice."
    });
    return actions.slice(0, 5);
  }

  if (audience === "municipal") {
    actions.push({ category: "Official check", text: plainOfficialAdvice(options) });
    if (metrics.heatScore >= 35) {
      actions.push({
        category: heatLevel,
        text: "Review outreach to vulnerable people, care facilities, cool spaces, drinking water, and outdoor work for the hottest part of the day."
      });
    }
    if (metrics.wetStressScore >= 35) {
      actions.push({
        category: wetLevel,
        text: metrics.wetStressScore >= 75
          ? "Escalate checks of official warnings, water levels, local sensors, underpasses, and drainage hotspots. Only authorised teams may decide closures, pumping, evacuation, or emergency deployment."
          : "Inspect known drainage and underpass hotspots, safely clear accessible inlets, and check pumps, access routes, and staff availability."
      });
    }
    if (metrics.dryStressScore >= 35) {
      actions.push({
        category: dryLevel,
        text: "Prioritise measured checks for young trees and important public planting. Review water availability, local restrictions, leaks, and fire conditions."
      });
    }
    actions.push({
      category: "Activation gate",
      text: "Use current observations, official warnings, local thresholds, available staff, and the responsible authority before activating a response."
    });
    return actions.slice(0, 5);
  }

  if (metrics.heatScore >= 35) {
    actions.push({
      category: heatLevel,
      text: metrics.heatScore >= 55
        ? "Move strenuous outdoor activity to a cooler part of the day, use shade or a cool indoor place, drink regularly, and check on heat-sensitive people."
        : "Prefer cooler morning or evening hours for strenuous activity, and keep water, shade, and a cooler indoor option available."
    });
  } else {
    actions.push({ category: "Plan", text: "Check the daily high before a longer outdoor activity and choose a cooler part of the day where possible." });
  }
  if (metrics.dryStressScore >= 35) {
    actions.push({
      category: dryLevel,
      text: metrics.dryStressScore >= 55
        ? "Check below the surface before watering sensitive plants. Water early or late only where needed and follow local restrictions."
        : "Check the soil a finger-depth below the surface before routine watering. Wait when it is still moist."
    });
  }
  if (metrics.wetStressScore >= 35) {
    actions.push({
      category: wetLevel,
      text: metrics.wetStressScore >= 55
        ? "Avoid flooded paths and underpasses, keep away from fast water, and follow local flood instructions."
        : "Delay routine watering and check pots and safely accessible drains for standing water."
    });
  }
  actions.push({ category: "Official check", text: plainOfficialAdvice(options) });
  return actions.slice(0, 4);
}

export function plainDecisionNote(audience, { isRetrospective = false, stale = false } = {}) {
  if (isRetrospective) {
    return "This past-date view is for review only. It must not be read as advice for today, and the current official-warning feed may not describe that past date.";
  }
  if (stale) {
    return "Action suggestions are paused because the data is too old. Check current official information and local conditions.";
  }
  if (audience === "farmers") {
    return "These suggestions help prioritise field checks. They do not set irrigation amounts, harvest timing, treatments, or other costly operations automatically.";
  }
  if (audience === "municipal") {
    return "These suggestions help prioritise preparedness checks. Only the responsible authority can activate an official response.";
  }
  return "These are low-regret planning suggestions. Current official health, weather, civil-protection, and local flood instructions take precedence.";
}
