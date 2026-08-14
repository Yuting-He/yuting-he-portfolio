import { evidenceConfidence, scoreForLayer, severity } from "./heatwave-model.js";
import { profileLabel, severityLabel } from "./heatwave-i18n.js";

const CONTEXT = Object.freeze({
  residents: {
    impact: "Alltagsplanung und hitzeempfindliche Personen",
    groundLabel: "Boden und Pflanzen",
    drySubject: "neu gepflanzte und flach wurzelnde Pflanzen"
  },
  farmers: {
    impact: "Feldarbeiten und Wasserbedarf der Kultur",
    groundLabel: "Wasser im Feld",
    drySubject: "die ausgewählte Kultur und ihren Wurzelraum"
  },
  gardeners: {
    impact: "die ausgewählten Zierpflanzen und ihren Standort",
    groundLabel: "Pflanzen und Wurzelraum",
    drySubject: "die ausgewählten Pflanzen und ihren Wurzelraum"
  },
  municipal: {
    impact: "kommunale Vorsorge und öffentliche Dienste",
    groundLabel: "Boden und Grünflächen",
    drySubject: "Jungbäume und hitzeempfindliche öffentliche Pflanzungen"
  }
});

const LAYER_CONCERN = Object.freeze({
  impact: "den ausgewählten Entscheidungskontext",
  heat: "Hitzebelastung",
  dry: "trockenen Boden und Wasserstress",
  wet: "sehr nassen Boden und stehendes Wasser"
});

export const PLAIN_SOURCE_SUMMARY_DE =
  "Grundlage sind Wetter- und Radardaten des Deutschen Wetterdienstes, Bodenwasserinformationen von UFZ und DWD sowie mehrere Prognosevarianten. Exakte Werte, Modellnamen und Zeitstempel stehen unter Technische Details.";

function levelFor(score) {
  return severityLabel("de", severity(score)).toLowerCase();
}

function roundedTemperature(value) {
  return Number.isFinite(value) ? `${Math.round(value)} °C` : "eine nicht verfügbare Temperatur";
}

function heatExplanation(metrics) {
  const feelsLike = roundedTemperature(metrics.apparentMaxC);
  const warmNight = Number.isFinite(metrics.tminC) && metrics.tminC >= 20
    ? " Auch die Nacht kann warm bleiben, sodass sich Menschen und Gebäude weniger erholen beziehungsweise abkühlen können."
    : "";
  if (metrics.heatScore >= 75) {
    return `Gefährliche Hitze ist möglich. In der heißesten Tagesphase kann es sich annähernd wie ${feelsLike} anfühlen.${warmNight}`;
  }
  if (metrics.heatScore >= 55) {
    return `In den wärmsten Stunden kann es sich sehr heiß anfühlen, mit einem Spitzenwert um ${feelsLike}. Anstrengende Tätigkeiten möglichst in kühlere Zeiten legen.${warmNight}`;
  }
  if (metrics.heatScore >= 35) {
    return `Die Nachmittagshitze kann deutlich spürbar sein; der Spitzenwert liegt etwa bei ${feelsLike}. Hitzeempfindliche Personen benötigen gegebenenfalls mehr Pausen und Schatten.${warmNight}`;
  }
  return `Hitze ist in dieser Ansicht nicht das Hauptthema. In der wärmsten Phase kann es sich dennoch wie etwa ${feelsLike} anfühlen.`;
}

function groundExplanation(metrics, audience) {
  const context = CONTEXT[audience] || CONTEXT.residents;
  if (metrics.wetStressScore >= 75 && metrics.wetStressScore > metrics.dryStressScore) {
    return `Der Boden kann sehr nass sein. Senken und schlecht entwässerte Bereiche vor Nutzung oder Bearbeitung prüfen; Wasser im Wurzelraum kann ${context.drySubject} beeinträchtigen.`;
  }
  if (metrics.wetStressScore >= 55 && metrics.wetStressScore > metrics.dryStressScore) {
    return "Der Boden kann nasser als üblich bleiben. Vor dem Gießen, Befahren von Flächen oder Bodenarbeiten die Bedingungen vor Ort prüfen.";
  }
  if (metrics.dryStressScore >= 75) {
    return `Der Boden kann bis in tiefere Schichten extrem trocken sein. Vor einer Bewässerungsentscheidung die Feuchte bei ${context.drySubject} im Wurzelraum prüfen.`;
  }
  if (metrics.dryStressScore >= 55) {
    return `Der Boden ist wahrscheinlich deutlich trockener als üblich. ${context.drySubject} im Wurzelraum prüfen und sichtbare Stressstellen priorisieren.`;
  }
  if (metrics.dryStressScore >= 35) {
    return "Eine gewisse Trockenheit ist möglich. Vor routinemäßigem Gießen unterhalb der Oberfläche prüfen, da benachbarte Böden unterschiedlich sein können.";
  }
  return "Es fällt kein starkes Signal für Trockenheit oder Vernässung auf. Boden und Entwässerung können lokal trotzdem abweichen.";
}

function rainExplanation(metrics) {
  if (metrics.wetStressScore >= 75) {
    return "Starker Regen oder bereits nasser Boden können Wasser rasch aufstauen. Tiefliegende Wege meiden und amtliche Hochwasser- oder Regenhinweise befolgen.";
  }
  if (metrics.wetStressScore >= 55) {
    return "In tiefen oder schlecht entwässerten Bereichen ist stehendes Wasser möglich. Entwässerung, Flächen und Zugangswege vor Ort prüfen.";
  }
  if (metrics.wetStressScore >= 35) {
    return "Einzelne Senken können nass werden. Langsam entwässernde Stellen beobachten und unnötiges Gießen verschieben.";
  }
  if (metrics.dryStressScore >= 55 && Number.isFinite(metrics.precipitationMm) && metrics.precipitationMm < 3) {
    return "Es wird kaum nutzbarer Niederschlag erwartet; die Trockenheit dürfte sich daher nicht schnell entspannen.";
  }
  if (Number.isFinite(metrics.precipitationMm) && metrics.precipitationMm >= 10) {
    return "Es kann eine nutzbare Regenmenge fallen. In schlecht entwässerten Bereichen kann sich dennoch Wasser sammeln.";
  }
  return "Es fällt kein starkes Signal für überschüssiges Wasser auf. Kurze Schauer können kleinräumig variieren; deshalb die lokale Prognose prüfen.";
}

function reviewHeat(metrics) {
  const warmNight = Number.isFinite(metrics.tminC) && metrics.tminC >= 20
    ? " Der Datenstand zeigte außerdem eine warme Nacht mit geringer Abkühlung."
    : "";
  return `Der Datenstand zeigte ein Hitzesignal der Stufe ${levelFor(metrics.heatScore)}; die wärmsten Bedingungen fühlten sich annähernd wie ${roundedTemperature(metrics.apparentMaxC)} an.${warmNight}`;
}

function reviewGround(metrics, audience) {
  const context = CONTEXT[audience] || CONTEXT.residents;
  if (metrics.wetStressScore >= 55 && metrics.wetStressScore > metrics.dryStressScore) {
    return metrics.wetStressScore >= 75
      ? `Der Datenstand zeigte sehr nassen Boden und mögliches Wasser im Wurzelraum für ${context.drySubject}.`
      : `Der Datenstand zeigte überdurchschnittlich nassen Boden und mögliches Wasser im Wurzelraum für ${context.drySubject}.`;
  }
  if (metrics.dryStressScore >= 75) return `Der Datenstand zeigte extrem trockenen Boden mit möglichem Stress für ${context.drySubject}.`;
  if (metrics.dryStressScore >= 55) return `Der Datenstand zeigte deutlich trockeneren Boden als üblich mit möglichem Stress für ${context.drySubject}.`;
  if (metrics.dryStressScore >= 35) return "Der Datenstand zeigte eine gewisse Bodentrockenheit und wahrscheinliche Unterschiede zwischen nahe gelegenen Orten.";
  return "Der Datenstand zeigte kein starkes Trockenheits- oder Vernässungssignal; lokal können die Bedingungen abgewichen sein.";
}

function reviewRain(metrics) {
  if (metrics.wetStressScore >= 75) return "Der Datenstand zeigte starken Regen oder sehr nassen Boden mit hoher Wahrscheinlichkeit von Wasseransammlungen in Senken.";
  if (metrics.wetStressScore >= 55) return "Der Datenstand zeigte mögliches stehendes Wasser in tiefen oder schlecht entwässerten Bereichen.";
  if (metrics.wetStressScore >= 35) return "Der Datenstand zeigte, dass einzelne Senken oder langsam entwässernde Stellen nass geworden sein könnten.";
  if (metrics.dryStressScore >= 55 && Number.isFinite(metrics.precipitationMm) && metrics.precipitationMm < 3) return "Der Datenstand zeigte wenig nutzbaren Regen; eine schnelle Entspannung der Trockenheit war daher unwahrscheinlich.";
  return "Der Datenstand zeigte kein starkes Nässe-Signal; kurze Schauer können lokal abgewichen sein.";
}

function confidenceExplanation(metrics, stale) {
  if (stale) return "Mindestens eine Datenquelle ist für aktuelle Handlungshinweise zu alt. Stattdessen aktuelle amtliche und lokale Informationen verwenden.";
  const confidence = evidenceConfidence(metrics);
  if (confidence.score >= 78) return "Die wichtigsten Eingangsdaten sind vollständig und die Prognosevarianten stimmen ausreichend überein. Innerhalb der ausgewählten Fläche sind dennoch lokale Unterschiede möglich.";
  if (confidence.score >= 58) return "Die Grundlage eignet sich für Planungsprüfungen, einzelne Beobachtungen oder Prognosevarianten sind jedoch unsicherer. Wichtige Entscheidungen vor Ort bestätigen.";
  return "Dies nur als frühes Signal behandeln. Vor einer Handlung sind lokale Beobachtungen und aktuelle amtliche Informationen besonders wichtig.";
}

export function plainConfidenceLabelDe(metrics, { stale = false, isRetrospective = false } = {}) {
  if (isRetrospective) return "Vergangenes Datum - nur zur Auswertung";
  if (stale) return "Veraltete Daten - Maßnahmen pausiert";
  const confidence = evidenceConfidence(metrics);
  if (confidence.score >= 78) return "Gute Planungsgrundlage";
  if (confidence.score >= 58) return "Nützlich, mit Unsicherheit";
  return "Frühes Signal - lokal prüfen";
}

export function plainLanguageSummaryDe(metrics, audience, layer, {
  regionName = "Diese Region",
  dateLabel = "das ausgewählte Datum",
  stale = false,
  isRetrospective = false
} = {}) {
  const level = levelFor(scoreForLayer(metrics, layer));
  const context = CONTEXT[audience] || CONTEXT.residents;
  const concern = layer === "impact" ? context.impact : LAYER_CONCERN[layer];
  if (isRetrospective) return `${regionName} am ${dateLabel}: Die Rekonstruktion für ein vergangenes Datum zeigte die Aufmerksamkeitsstufe ${level} für ${concern}. Sie dient der Auswertung, nicht aktuellen Maßnahmen.`;
  if (stale) return `${regionName} am ${dateLabel}: Ein veralteter Datenstand zeigt die Aufmerksamkeitsstufe ${level} für ${concern}. Vor Entscheidungen aktuelle Daten nutzen.`;
  return `${regionName} am ${dateLabel}: Aufmerksamkeitsstufe ${level} für ${concern}. Die folgenden Punkte zeigen, was als Nächstes geprüft werden sollte.`;
}

export function plainLanguageSignalsDe(metrics, audience, layer, { stale = false, isRetrospective = false } = {}) {
  const context = CONTEXT[audience] || CONTEXT.residents;
  const selectedLevel = severityLabel("de", severity(scoreForLayer(metrics, layer)));
  if (stale || isRetrospective) {
    const view = isRetrospective ? "Rekonstruktion eines vergangenen Datums" : "veralteten Datenstand";
    return [
      { label: "Gesamtsituation", text: `Aufmerksamkeitsstufe ${selectedLevel} in dieser Ansicht (${view}). Sie dient der Auswertung und ist keine aktuelle Anweisung.` },
      { label: "Hitze", text: reviewHeat(metrics) },
      { label: context.groundLabel, text: reviewGround(metrics, audience) },
      { label: "Regen und stehendes Wasser", text: reviewRain(metrics) },
      { label: "Aussagesicherheit", text: isRetrospective ? "Diese Rekonstruktion verbindet Daten zum ausgewählten Datum. Mit archivierten amtlichen Informationen und dokumentierten lokalen Bedingungen vergleichen." : confidenceExplanation(metrics, true) }
    ];
  }
  return [
    { label: "Gesamtsituation", text: `Aufmerksamkeitsstufe ${selectedLevel} in der ausgewählten Ansicht. Dies ist ein Planungssignal, keine amtliche Warnung und keine automatische Anweisung.` },
    { label: "Hitze", text: heatExplanation(metrics) },
    { label: context.groundLabel, text: groundExplanation(metrics, audience) },
    { label: "Regen und stehendes Wasser", text: rainExplanation(metrics) },
    { label: "Aussagesicherheit", text: confidenceExplanation(metrics, stale) }
  ];
}

export function plainActionCategoryDe(category) {
  const labels = {
    "Official check": "Amtliche Hinweise prüfen",
    Verify: "Vor Ort prüfen",
    Validate: "Vor Ort prüfen",
    "Check locally": "Vor Ort prüfen",
    "Do not automate": "Menschliche Entscheidung erforderlich",
    "Activation gate": "Vor Aktivierung",
    Retrospective: "Vergangenheitskontext",
    "Very high": "Prioritäre Maßnahme",
    High: "Prioritäre Maßnahme",
    Moderate: "Sinnvoller Schritt",
    Plan: "Vorausplanen"
  };
  return labels[category] || category;
}

function officialAdvice({ heatWarningCount = 0, rainWarningCount = 0 } = {}) {
  if (heatWarningCount > 0 && rainWarningCount > 0) return "Für dieses Datum werden amtliche Hitze- und Regenwarnungen angezeigt. Vor einer Handlung die Details öffnen.";
  if (heatWarningCount > 0) return "Für dieses Datum wird eine amtliche Hitzewarnung angezeigt. Vor einer Handlung die Details öffnen.";
  if (rainWarningCount > 0) return "Für dieses Datum wird eine amtliche Regenwarnung angezeigt. Details und zuständige Hochwasserzentrale prüfen.";
  return "Aktuelle amtliche Wetterwarnungen prüfen; bei möglichem Wasseraufstau oder steigenden Flüssen zusätzlich die zuständige Hochwasserzentrale nutzen.";
}

function action(category, text, focus = false) {
  return { category, text, ...(focus ? { focus: true } : {}) };
}

export function plainActionsForDe(metrics, audience, options = {}) {
  const heatLevel = severityLabel("de", severity(metrics.heatScore));
  const dryLevel = severityLabel("de", severity(metrics.dryStressScore));
  const wetLevel = severityLabel("de", severity(metrics.wetStressScore));
  const actions = [];

  if (audience === "farmers") {
    const crop = profileLabel("de", "crops", metrics.crop, "ausgewählte Kultur");
    const stage = profileLabel("de", "stages", metrics.stage, "Entwicklungsstadium");
    actions.push(action("Vor Ort prüfen", `Mehrere repräsentative Stellen des Feldes für ${crop} prüfen: Feuchte im Wurzelraum, Kultursymptome und jüngsten Regen gemeinsam betrachten. Das Stadium ${stage} wurde ${metrics.stageAuto ? "aus dem Datum geschätzt" : "manuell gewählt"}.`));
    const focusActions = {
      overview: action("Gesamtprüfung", "Trockenen Boden, Vernässung, Hitze und Entwicklungsstadium gemeinsam betrachten. Vor Änderungen den Feldbereich prüfen, der vermutlich am wenigsten dem regionalen Mittel entspricht.", true),
      irrigation: action("Bewässerung", metrics.precipitationMm >= 8 && metrics.dryStressScore < 75
        ? "Erwarteter Regen kann die Feldbilanz verändern. Nach dem Regen den Wurzelraum erneut prüfen, bevor Bewässerung eingeplant wird."
        : "Repräsentative Wurzelraummessungen, Kulturzustand, erwarteten Regen, Wasserverfügbarkeit und betriebliche Schwellenwerte vergleichen. Diese Ansicht berechnet keine Bewässerungsmenge.", true),
      fieldAccess: action("Befahrbarkeit", metrics.wetStressScore >= 35
        ? "Senken, Vorgewende, Fahrspuren und langsam entwässernde Böden vor dem Befahren prüfen. Bei Gefahr von Spurbildung, Verdichtung, Erosion oder unsicherem Zugang die Befahrung verschieben."
        : "Kein starkes Nässe-Signal, dennoch Senken und die am schlechtesten entwässerte Teilfläche vor Maschineneinsatz prüfen.", true),
      workTiming: action("Arbeitszeit", metrics.heatScore >= 35
        ? "Anstrengende Arbeiten möglichst in kühlere Tageszeiten verlegen und Wasser, Schatten, Pausen sowie Tierkontrollen einplanen."
        : "Lokale Stundenprognose, Belastung der Beschäftigten und Tierbedingungen prüfen, bevor das Arbeitsfenster festgelegt wird.", true)
    };
    actions.push(focusActions[metrics.farmGoal] || focusActions.overview);
    if (metrics.dryStressScore >= 35) actions.push(action(`Trockenstress: ${dryLevel}`, metrics.dryStressScore >= 75
      ? "Empfindliche Stadien sowie leichte und flachgründige Böden zuerst prüfen. Vor größeren Eingriffen Wasserverfügbarkeit, örtliche Regeln und qualifizierte Pflanzenbauberatung bestätigen."
      : "Empfindliche Stadien und leichtere Böden zuerst prüfen. Feldmessungen und betriebliche Bewässerungsschwellen verwenden; HeatLens berechnet keine Wassermenge."));
    if (metrics.wetStressScore >= 35) actions.push(action(`Nässestress: ${wetLevel}`, metrics.wetStressScore >= 75
      ? "Schwere Maschinen von überfluteten oder vernässten Flächen fernhalten. Sicherheit von Menschen und Tieren priorisieren und amtliche Hochwasserinformationen nutzen."
      : "Tiefe und schlecht entwässerte Feldbereiche vor Maschineneinsatz auf stehendes Wasser, Erosion, Bodenschäden und Krankheitssymptome prüfen."));
    if (metrics.heatScore >= 35) actions.push(action(`Hitzestufe: ${heatLevel}`, "Hitzeempfindliche Kulturstadien, Wasser und Schatten für Tiere sowie die Belastung der Beschäftigten prüfen. Anstrengende Arbeiten möglichst in kühlere Tageszeiten legen."));
    return [...actions.slice(0, 4), action("Menschliche Entscheidung erforderlich", "Erntezeitpunkt, Bewässerungsmenge, Pflanzenschutz oder andere kostenintensive Maßnahmen nicht allein anhand von HeatLens ändern. Bedingungen im Feld bestätigen und qualifizierte lokale Beratung einbeziehen.")];
  }

  if (audience === "gardeners") {
    const plant = profileLabel("de", "plants", metrics.plant, "ausgewählte Pflanzen");
    actions.push(action("Vor Ort prüfen", `${plant} am tatsächlichen Standort prüfen. Topf, Hochbeet, Regenschatten und einzelner Wurzelballen können deutlich trockener oder nasser als das Kartenumfeld sein.`));
    const watering = action("Gießprüfung", metrics.wetStressScore >= 55
      ? "Routinemäßiges Gießen pausieren, stehendes Wasser aus Gefäßen soweit sinnvoll entfernen und den Wurzelraum abtrocknen lassen, bevor erneut geprüft wird."
      : metrics.precipitationMm >= 8 && metrics.dryStressScore < 75
        ? "Nutzbarer Regen ist prognostiziert. Danach prüfen, ob er den Wurzelraum erreicht hat; unter Dachüberständen kann es weiterhin trocken sein."
        : metrics.plant === "seasonalFlowers" || metrics.gardenSetting === "container"
          ? "Wenige Zentimeter unter der Substratoberfläche prüfen und Topfgewicht oder sichtbares Welken als zweiten Hinweis nutzen. Bei trockenem Wurzelraum morgens gießen und überschüssiges Wasser ablaufen lassen."
          : metrics.plant === "newlyPlantedWoody"
            ? "Ursprünglichen Wurzelballen und angrenzenden Boden prüfen. Junge Gehölze bei Trockenheit priorisieren, den Wurzelraum langsam wässern und vor Wiederholung erneut kontrollieren."
            : metrics.plant === "establishedWoody"
              ? "Nicht allein auf eine trockene Oberfläche reagieren. Tiefer prüfen und auf anhaltenden Stress achten; etablierte Gehölze werden meist erst bei länger anhaltender Trockenheit prioritär."
              : metrics.plant === "droughtTolerant"
                ? "Die obere Bodenschicht zwischen Prüfungen abtrocknen lassen. Nicht allein wegen des Kartensignals routinemäßig gießen, da dauerhaft nasse Wurzeln das größere Risiko sein können."
                : "Unterhalb der Oberfläche prüfen und auf Welken achten, das morgens bestehen bleibt. Bei trockenem Wurzelraum morgens gießen und vor Wiederholung erneut prüfen.");
    const heat = action("Hitzeschutz", metrics.heatScore >= 35
      ? metrics.gardenSetting === "container"
        ? "Empfindliche Töpfe soweit praktikabel aus harter Nachmittagssonne nehmen, das Gefäß beschatten und die Feuchte morgens prüfen."
        : "Neu gepflanzte oder sichtbar gestresste Pflanzen soweit praktikabel vor harter Nachmittagssonne schützen; während der Spitzenhitze weder stark schneiden noch umpflanzen."
      : "Kein starkes Hitzesignal. Die normale lokale Prüfung beibehalten und nicht nur wegen trockener Oberfläche zusätzlich gießen.");
    const wet = metrics.wetStressScore >= 35 || metrics.gardenGoal === "waterlogging"
      ? action("Entwässerungsprüfung", "Untersetzer, Gefäße, Senken und langsam entwässernde Beete prüfen. Gießen verschieben und gesättigten Boden bis zur Entwässerung nicht betreten.")
      : null;
    const season = action("Saisonkontext", metrics.gardenSeason === "dormant"
      ? "Winter- oder Ruhezeit: seltener gießen und erst nach Prüfung von Feuchte, Frost, Entwässerung sowie Bedarf immergrüner oder geschützter Pflanzen handeln."
      : metrics.gardenSeason === "summerStress"
        ? "Hauptzeit für Hitze und Wasserbedarf: empfindliche Pflanzen häufiger kontrollieren, aber Pflanzen- und Wurzelraumprüfung statt eines festen Kalenders verwenden."
        : `Es ist die ${profileLabel("de", "gardenSeasons", metrics.gardenSeason, metrics.gardenSeasonLabel)}. Neu gepflanztes Material während Etablierung oder Erholung priorisieren.`);
    const focusedKey = metrics.gardenGoal === "overview" ? "season" : metrics.gardenGoal;
    const tailored = { watering, heatProtection: heat, waterlogging: wet, season };
    Object.entries(tailored).forEach(([key, item]) => { if (item) item.focus = key === focusedKey; });
    const order = { overview: ["season", "watering", "heatProtection", "waterlogging"], watering: ["watering", "season", "heatProtection", "waterlogging"], heatProtection: ["heatProtection", "watering", "season", "waterlogging"], waterlogging: ["waterlogging", "watering", "season", "heatProtection"] };
    for (const key of order[metrics.gardenGoal] || order.overview) if (tailored[key]) actions.push(tailored[key]);
    return [...actions.slice(0, 4), action("Amtliche Hinweise prüfen", officialAdvice(options))];
  }

  if (audience === "municipal") {
    actions.push(action("Amtliche Hinweise prüfen", officialAdvice(options)));
    if (metrics.heatScore >= 35) actions.push(action(`Hitzestufe: ${heatLevel}`, "Ansprache gefährdeter Personen, Pflegeeinrichtungen, kühle Räume, Trinkwasserangebote und Außenarbeiten für die heißeste Tagesphase prüfen."));
    if (metrics.wetStressScore >= 35) actions.push(action(`Nässestress: ${wetLevel}`, metrics.wetStressScore >= 75
      ? "Amtliche Warnungen, Pegel, lokale Sensoren, Unterführungen und Entwässerungsschwerpunkte verstärkt prüfen. Nur befugte Stellen entscheiden über Sperrungen, Pumpen, Evakuierungen oder Einsatzmaßnahmen."
      : "Bekannte Entwässerungs- und Unterführungsschwerpunkte prüfen, sicher zugängliche Einläufe freihalten und Pumpen, Zufahrten sowie Personalverfügbarkeit kontrollieren."));
    if (metrics.dryStressScore >= 35) actions.push(action(`Trockenstress: ${dryLevel}`, "Messgestützte Kontrollen für Jungbäume und wichtige öffentliche Pflanzungen priorisieren. Wasserverfügbarkeit, örtliche Regeln, Leckagen und Brandbedingungen prüfen."));
    actions.push(action("Vor Aktivierung", "Aktuelle Beobachtungen, amtliche Warnungen, lokale Schwellenwerte, verfügbares Personal und die zuständige Behörde einbeziehen, bevor Maßnahmen aktiviert werden."));
    return actions.slice(0, 5);
  }

  if (metrics.heatScore >= 35) actions.push(action(`Hitzestufe: ${heatLevel}`, metrics.heatScore >= 55
    ? "Anstrengende Aktivitäten im Freien in kühlere Tageszeiten verlegen, Schatten oder kühle Innenräume nutzen, regelmäßig trinken und hitzeempfindliche Personen unterstützen."
    : "Für anstrengende Aktivitäten möglichst kühlere Morgen- oder Abendstunden wählen und Wasser, Schatten sowie eine kühle Innenraumoption bereithalten."));
  else actions.push(action("Vorausplanen", "Vor längeren Aktivitäten im Freien die Tageshöchsttemperatur prüfen und möglichst eine kühlere Tageszeit wählen."));
  if (metrics.dryStressScore >= 35) actions.push(action(`Trockenstress: ${dryLevel}`, metrics.dryStressScore >= 55
    ? "Bei empfindlichen Pflanzen vor dem Gießen unter der Oberfläche prüfen. Nur bei Bedarf früh oder spät gießen und örtliche Regeln beachten."
    : "Vor routinemäßigem Gießen die Bodenfeuchte eine Fingerbreite unter der Oberfläche prüfen. Bei noch feuchtem Boden warten."));
  if (metrics.wetStressScore >= 35) actions.push(action(`Nässestress: ${wetLevel}`, metrics.wetStressScore >= 55
    ? "Überflutete Wege und Unterführungen meiden, Abstand zu schnell fließendem Wasser halten und lokale Hochwasserhinweise befolgen."
    : "Routinemäßiges Gießen verschieben und Töpfe sowie sicher zugängliche Abflüsse auf stehendes Wasser prüfen."));
  actions.push(action("Amtliche Hinweise prüfen", officialAdvice(options)));
  return actions.slice(0, 4);
}

export function plainDecisionNoteDe(audience, { isRetrospective = false, stale = false } = {}) {
  if (isRetrospective) return "Diese Ansicht eines vergangenen Datums dient nur der Auswertung. Sie ist keine Empfehlung für heute; der aktuelle amtliche Warnfeed beschreibt das vergangene Datum möglicherweise nicht.";
  if (stale) return "Handlungsvorschläge sind pausiert, weil die Daten zu alt sind. Aktuelle amtliche Informationen und lokale Bedingungen prüfen.";
  if (audience === "farmers") return "Diese Hinweise priorisieren Feldprüfungen. Sie legen weder Bewässerungsmengen noch Erntezeitpunkt, Behandlungen oder andere kostenintensive Maßnahmen automatisch fest.";
  if (audience === "gardeners") return "Diese Hinweise helfen bei der nächsten Prüfung. Vor einer Handlung den tatsächlichen Topf oder das Beet, den Pflanzenzustand, die Entwässerung und lokale Gießregeln beachten.";
  if (audience === "municipal") return "Diese Hinweise priorisieren Vorsorgeprüfungen. Nur die zuständige Behörde kann eine offizielle Reaktion aktivieren.";
  return "Dies sind risikoarme Planungshinweise. Aktuelle amtliche Gesundheits-, Wetter-, Katastrophenschutz- und Hochwasserhinweise haben Vorrang.";
}

export function technicalGuidanceForDe(metrics, audience, options = {}) {
  const notes = {
    farmers: "Die landwirtschaftlichen Hinweise sind eine abgestufte Prüfliste. Feldbeobachtungen, Kultur- und Bodenparameter, amtliche Prognosen, Wasserregeln, Produktvorgaben und qualifizierte Beratung bleiben entscheidend.",
    gardeners: "Die Gartenhinweise übersetzen regionale Wetter- und Bodenwassersignale in beobachtungsbasierte Prüfungen. Pflanzenzustand, Feuchte in Topf oder Beet, Entwässerung, örtliche Regeln und Produktangaben bleiben entscheidend.",
    municipal: "HeatLens ordnet Vorsorgeprüfungen; es gibt keine amtliche Warnung heraus und aktiviert keine kommunale Reaktion.",
    residents: "Hinweise für die Bevölkerung beschränken sich auf risikoarme Handlungen. Amtliche DWD-, Gesundheits-, Katastrophenschutz- und lokale Hochwasserhinweise haben Vorrang."
  };
  return { actions: plainActionsForDe(metrics, audience, options), note: notes[audience] || notes.residents };
}
