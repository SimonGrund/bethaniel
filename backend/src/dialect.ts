// ── Deterministic English dialect normalization ──
// The copy-edit prompt tells the model to convert British↔American spelling
// pairs, but LLMs miss occurrences (a real manuscript shipped with both
// "Grey" and "Gray" under the American setting). This module generates
// mechanical corrections from a curated pair list, mirroring how the
// deterministic spell-check corrections work: emitted per chunk in queue.ts,
// tagged reason "dialect", union-deduped and reviewed like any other
// correction.
//
// Safety rules:
// - Curated pairs only, inflections listed explicitly — no algorithmic
//   suffix rewriting, so nothing is ever invented.
// - Directional flags: pairs where one direction is ambiguous (BrE splits
//   licence/license by part of speech; "tire" is also a verb; "meter" is a
//   device in BrE too) only fire in the safe direction.
// - Distinct surface casings each get their own correction so "Grey" → "Gray"
//   (applyCorrections does exact-text replacement with no case logic).

import type { Correction } from "./types.js";

interface DialectPair {
  br: string;
  us: string;
  /** Convert br→us when target dialect is american. Default true. */
  toUs?: boolean;
  /** Convert us→br when target dialect is british. Default true. */
  toBr?: boolean;
}

const p = (br: string, us: string, flags?: Partial<DialectPair>): DialectPair => ({
  br,
  us,
  ...flags,
});

export const DIALECT_PAIRS: DialectPair[] = [
  // grey family
  p("grey", "gray"),
  p("greys", "grays"),
  p("greyed", "grayed"),
  p("greyish", "grayish"),
  // -our family
  p("colour", "color"),
  p("colours", "colors"),
  p("coloured", "colored"),
  p("colourful", "colorful"),
  p("colourless", "colorless"),
  p("favour", "favor"),
  p("favours", "favors"),
  p("favoured", "favored"),
  p("favourite", "favorite"),
  p("favourites", "favorites"),
  p("honour", "honor"),
  p("honours", "honors"),
  p("honoured", "honored"),
  p("honourable", "honorable"),
  p("labour", "labor"),
  p("laboured", "labored"),
  p("neighbour", "neighbor"),
  p("neighbours", "neighbors"),
  p("neighbouring", "neighboring"),
  p("neighbourhood", "neighborhood"),
  p("behaviour", "behavior"),
  p("behaviours", "behaviors"),
  p("flavour", "flavor"),
  p("flavours", "flavors"),
  p("flavoured", "flavored"),
  p("harbour", "harbor"),
  p("harbours", "harbors"),
  p("harboured", "harbored"),
  p("humour", "humor"),
  p("humoured", "humored"),
  p("rumour", "rumor"),
  p("rumours", "rumors"),
  p("rumoured", "rumored"),
  p("armour", "armor"),
  p("armoured", "armored"),
  p("odour", "odor"),
  p("odours", "odors"),
  p("parlour", "parlor"),
  p("splendour", "splendor"),
  p("valour", "valor"),
  p("vigour", "vigor"),
  p("saviour", "savior"),
  p("endeavour", "endeavor"),
  p("endeavours", "endeavors"),
  // -re family
  p("centre", "center"),
  p("centres", "centers"),
  p("centred", "centered"),
  p("theatre", "theater"),
  p("theatres", "theaters"),
  p("litre", "liter"),
  p("litres", "liters"),
  // "meter" is also the BrE word for the measuring device — us→br unsafe.
  p("metre", "meter", { toBr: false }),
  p("metres", "meters", { toBr: false }),
  p("fibre", "fiber"),
  p("fibres", "fibers"),
  p("sombre", "somber"),
  p("lustre", "luster"),
  p("spectre", "specter"),
  p("spectres", "specters"),
  p("calibre", "caliber"),
  p("manoeuvre", "maneuver"),
  p("manoeuvres", "maneuvers"),
  p("manoeuvred", "maneuvered"),
  // -ise/-ize family (true pairs only)
  p("realise", "realize"),
  p("realises", "realizes"),
  p("realised", "realized"),
  p("realising", "realizing"),
  p("recognise", "recognize"),
  p("recognises", "recognizes"),
  p("recognised", "recognized"),
  p("recognising", "recognizing"),
  p("organise", "organize"),
  p("organised", "organized"),
  p("organising", "organizing"),
  p("organisation", "organization"),
  p("organisations", "organizations"),
  p("apologise", "apologize"),
  p("apologised", "apologized"),
  p("apologising", "apologizing"),
  p("criticise", "criticize"),
  p("criticised", "criticized"),
  p("emphasise", "emphasize"),
  p("emphasised", "emphasized"),
  p("minimise", "minimize"),
  p("minimised", "minimized"),
  p("maximise", "maximize"),
  p("summarise", "summarize"),
  p("summarised", "summarized"),
  // -ce/-se
  p("defence", "defense"),
  p("defences", "defenses"),
  p("offence", "offense"),
  p("offences", "offenses"),
  p("pretence", "pretense"),
  // BrE splits these by part of speech (licence noun / license verb;
  // practise verb / practice noun) — only the AmE direction is mechanical.
  p("licence", "license", { toBr: false }),
  p("licences", "licenses", { toBr: false }),
  p("practise", "practice", { toBr: false }),
  p("practised", "practiced", { toBr: false }),
  p("practising", "practicing", { toBr: false }),
  // double-L
  p("travelled", "traveled"),
  p("travelling", "traveling"),
  p("traveller", "traveler"),
  p("travellers", "travelers"),
  p("cancelled", "canceled"),
  p("cancelling", "canceling"),
  p("modelling", "modeling"),
  p("labelled", "labeled"),
  p("labelling", "labeling"),
  p("marvellous", "marvelous"),
  p("jewellery", "jewelry"),
  p("woollen", "woolen"),
  p("counsellor", "counselor"),
  p("counsellors", "counselors"),
  // misc
  p("aluminium", "aluminum"),
  p("plough", "plow"),
  p("ploughed", "plowed"),
  p("ploughs", "plows"),
  p("mould", "mold"),
  p("mouldy", "moldy"),
  p("moulded", "molded"),
  p("smoulder", "smolder"),
  p("smouldering", "smoldering"),
  p("smouldered", "smoldered"),
  p("pyjamas", "pajamas"),
  p("moustache", "mustache"),
  p("moustaches", "mustaches"),
  p("sceptical", "skeptical"),
  p("sceptic", "skeptic"),
  p("sceptics", "skeptics"),
  // One-directional: the AmE word has unrelated senses in both dialects.
  p("cheque", "check", { toBr: false }),
  p("cheques", "checks", { toBr: false }),
  p("kerb", "curb", { toBr: false }),
  p("kerbs", "curbs", { toBr: false }),
  p("tyre", "tire", { toBr: false }),
  p("tyres", "tires", { toBr: false }),
  p("storey", "story", { toBr: false }),
  p("storeys", "stories", { toBr: false }),
  // ── Additional -our nouns (only the -our forms; -orous/-or derivatives like
  //    humorous, glamorous, vigorous are identical in both dialects) ──
  p("fervour", "fervor"),
  p("ardour", "ardor"),
  p("candour", "candor"),
  p("rigour", "rigor"),
  p("rigours", "rigors"),
  p("vapour", "vapor"),
  p("vapours", "vapors"),
  p("clamour", "clamor"),
  p("clamours", "clamors"),
  p("clamoured", "clamored"),
  p("clamouring", "clamoring"),
  p("demeanour", "demeanor"),
  p("glamour", "glamor"),
  p("tumour", "tumor"),
  p("tumours", "tumors"),
  p("savour", "savor"),
  p("savours", "savors"),
  p("savoured", "savored"),
  p("savouring", "savoring"),
  p("savoury", "savory"),
  p("behavioural", "behavioral"),
  p("colouring", "coloring"),
  p("favourable", "favorable"),
  p("favourably", "favorably"),
  p("honourably", "honorably"),
  p("labours", "labors"),
  p("labouring", "laboring"),
  p("labourer", "laborer"),
  p("labourers", "laborers"),
  // ── Additional -ise/-ize (and -yse/-yze) verbs — true dialect pairs only.
  //    NOT added: advertise, surprise, comprise, compromise, exercise, revise,
  //    devise, supervise, improvise, disguise, franchise, advise, despise,
  //    chastise, televise, promise, premise, expertise (always -ise). ──
  p("materialise", "materialize"),
  p("materialised", "materialized"),
  p("materialises", "materializes"),
  p("materialising", "materializing"),
  p("characterise", "characterize"),
  p("characterised", "characterized"),
  p("characterising", "characterizing"),
  p("specialise", "specialize"),
  p("specialised", "specialized"),
  p("specialising", "specializing"),
  p("specialisation", "specialization"),
  p("standardise", "standardize"),
  p("standardised", "standardized"),
  p("familiarise", "familiarize"),
  p("familiarised", "familiarized"),
  p("sympathise", "sympathize"),
  p("sympathised", "sympathized"),
  p("sympathising", "sympathizing"),
  p("symbolise", "symbolize"),
  p("symbolised", "symbolized"),
  p("utilise", "utilize"),
  p("utilised", "utilized"),
  p("utilising", "utilizing"),
  p("utilisation", "utilization"),
  p("visualise", "visualize"),
  p("visualised", "visualized"),
  p("visualising", "visualizing"),
  p("categorise", "categorize"),
  p("categorised", "categorized"),
  p("prioritise", "prioritize"),
  p("prioritised", "prioritized"),
  p("prioritising", "prioritizing"),
  p("memorise", "memorize"),
  p("memorised", "memorized"),
  p("civilise", "civilize"),
  p("civilised", "civilized"),
  p("civilisation", "civilization"),
  p("colonise", "colonize"),
  p("colonised", "colonized"),
  p("colonisation", "colonization"),
  p("modernise", "modernize"),
  p("modernised", "modernized"),
  p("normalise", "normalize"),
  p("normalised", "normalized"),
  p("stabilise", "stabilize"),
  p("stabilised", "stabilized"),
  p("authorise", "authorize"),
  p("authorised", "authorized"),
  p("authorisation", "authorization"),
  p("vaporise", "vaporize"),
  p("vaporised", "vaporized"),
  // fill out inflections for -ise verbs already present above
  p("apologises", "apologizes"),
  p("criticises", "criticizes"),
  p("criticising", "criticizing"),
  p("emphasises", "emphasizes"),
  p("emphasising", "emphasizing"),
  p("minimises", "minimizes"),
  p("minimising", "minimizing"),
  p("maximised", "maximized"),
  p("maximises", "maximizes"),
  p("maximising", "maximizing"),
  p("summarises", "summarizes"),
  p("summarising", "summarizing"),
  // -yse/-yze
  p("analyse", "analyze"),
  p("analysed", "analyzed"),
  p("analyses", "analyzes"),
  p("analysing", "analyzing"),
  p("paralyse", "paralyze"),
  p("paralysed", "paralyzed"),
  p("paralyses", "paralyzes"),
  p("paralysing", "paralyzing"),
  p("catalyse", "catalyze"),
  p("catalysed", "catalyzed"),
  // ── -ment / single-l vs double-l (BrE keeps one l; -ed/-ing forms are
  //    identical in both, so only base / -s / -ment differ) ──
  p("fulfil", "fulfill"),
  p("fulfils", "fulfills"),
  p("fulfilment", "fulfillment"),
  p("enrol", "enroll"),
  p("enrols", "enrolls"),
  p("enrolment", "enrollment"),
  p("instil", "instill"),
  p("instils", "instills"),
  p("distil", "distill"),
  p("distils", "distills"),
  p("enthral", "enthrall"),
  p("instalment", "installment"),
  p("instalments", "installments"),
  p("skilful", "skillful"),
  p("skilfully", "skillfully"),
  p("wilful", "willful"),
  p("wilfully", "willfully"),
  // more double-L inflected verbs (BrE doubles the l)
  p("modelled", "modeled"),
  p("levelled", "leveled"),
  p("levelling", "leveling"),
  p("signalled", "signaled"),
  p("signalling", "signaling"),
  p("fuelled", "fueled"),
  p("fuelling", "fueling"),
  p("counselled", "counseled"),
  p("counselling", "counseling"),
  p("marvelled", "marveled"),
  p("marvelling", "marveling"),
  p("totalled", "totaled"),
  p("dialled", "dialed"),
  p("dialling", "dialing"),
  // ── Additional -re words ──
  p("sceptre", "scepter"),
  p("sceptres", "scepters"),
  p("sabre", "saber"),
  p("sabres", "sabers"),
  p("meagre", "meager"),
  p("ochre", "ocher"),
  p("calibres", "calibers"),
  // ── -ae / -oe (British digraphs) ──
  p("anaemia", "anemia"),
  p("anaemic", "anemic"),
  p("anaesthetic", "anesthetic"),
  p("anaesthetics", "anesthetics"),
  p("anaesthesia", "anesthesia"),
  p("foetus", "fetus"),
  p("foetuses", "fetuses"),
  p("foetal", "fetal"),
  p("oestrogen", "estrogen"),
  p("oesophagus", "esophagus"),
  p("paediatric", "pediatric"),
  p("paediatrics", "pediatrics"),
  p("paediatrician", "pediatrician"),
  p("orthopaedic", "orthopedic"),
  p("gynaecology", "gynecology"),
  p("encyclopaedia", "encyclopedia"),
  p("encyclopaedias", "encyclopedias"),
  p("mediaeval", "medieval"),
  p("diarrhoea", "diarrhea"),
];

/** Reshape `target` to match the casing pattern of `surface`. */
function matchCase(surface: string, target: string): string {
  if (surface.length === 0) return target;
  if (/^[A-Z]+$/.test(surface) && surface.length > 1) {
    return target.toUpperCase();
  }
  if (/^[A-Z]/.test(surface)) {
    return target.charAt(0).toUpperCase() + target.slice(1);
  }
  return target;
}

export interface DialectOptions {
  /** Words to leave alone (e.g. character names from the style guide). */
  styleGuideNames?: string[];
  /** Cap on emitted corrections. Default 40. */
  maxHints?: number;
}

/**
 * Deterministic wrong-dialect spellings found in `text`, as corrections.
 * One correction per distinct surface casing (applyCorrections replaces every
 * boundary-checked occurrence of each).
 */
export function getDialectCorrections(
  text: string,
  dialect: "american" | "british",
  opts: DialectOptions = {},
): Correction[] {
  const maxHints = opts.maxHints ?? 40;
  const skip = new Set(
    (opts.styleGuideNames ?? []).flatMap((n) =>
      n
        .split(/[^\p{L}'’-]+/u)
        .filter(Boolean)
        .map((w) => w.toLowerCase()),
    ),
  );

  const out: Correction[] = [];
  const seen = new Set<string>();

  for (const pair of DIALECT_PAIRS) {
    const active =
      dialect === "american" ? (pair.toUs ?? true) : (pair.toBr ?? true);
    if (!active) continue;
    const from = dialect === "american" ? pair.br : pair.us;
    const to = dialect === "american" ? pair.us : pair.br;
    if (skip.has(from)) continue;

    const re = new RegExp(`\\b${from}\\b`, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const surface = m[0];
      if (seen.has(surface)) continue;
      seen.add(surface);
      out.push({ original: surface, corrected: matchCase(surface, to) });
      if (out.length >= maxHints) return out;
    }
  }
  return out;
}
