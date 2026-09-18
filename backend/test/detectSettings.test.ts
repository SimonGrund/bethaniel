// Betty asks the author to declare the manuscript language, the English
// dialect and two comma conventions before she has read a word of the book.
// The book itself answers all four. These tests pin the deterministic
// detectors that read those answers off the text — no model involved.
//
// The detectors are deliberately conservative: every one of them can return
// "unsure", and unsure is a first-class answer that the UI shows as a badge
// asking the author to decide. A wrong confident answer is far worse than an
// honest shrug, so the thresholds here are the real specification.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  detectManuscriptLanguage,
  detectEnglishDialect,
  detectOxfordComma,
  detectIntroductoryComma,
  detectDanishComma,
  detectSettings,
  DIALECT_EVIDENCE,
  type Detection,
} from "../src/detectSettings.ts";

// ── helpers ──

/** Assert a detector committed to an answer, and hand back that answer. */
function value<T>(d: Detection<T>): T {
  assert.equal(d.status, "detected");
  if (d.status !== "detected") throw new Error("unreachable");
  return d.value;
}

function assertUnsure<T>(d: Detection<T>, why: string): void {
  assert.equal(d.status, "unsure", why);
}

// ── fixtures ──
// Real prose, not word salad: the detectors run on novels.

const ENGLISH = `
She had not expected the house to be so quiet. The hallway was dark, and the
door to the kitchen stood open, as it always had. Nothing in the room had
moved since the last time she was here, and that was the thing that frightened
her. She put her bag down on the table and listened. Somewhere above her a
floorboard settled. It was the sort of sound an old house makes on its own,
but she did not believe that, and she was not going upstairs to find out.
`;

const DANISH = `
Hun havde ikke regnet med at huset ville være så stille. Gangen var mørk, og
døren ind til køkkenet stod åben, som den altid havde gjort. Intet i rummet
var flyttet siden sidste gang hun var her, og det var netop det der skræmte
hende. Hun satte tasken på bordet og lyttede. Et sted over hende knagede et
gulvbræt. Det var den slags lyd et gammelt hus laver helt af sig selv, men
det troede hun ikke på, og hun ville ikke gå ovenpå for at se efter.
`;

const GERMAN = `
Sie hatte nicht erwartet, dass das Haus so still sein würde. Der Flur war
dunkel, und die Tür zur Küche stand offen, wie sie es immer getan hatte.
Nichts in dem Raum hatte sich bewegt seit dem letzten Mal, als sie hier war,
und genau das war es, was ihr Angst machte. Sie stellte ihre Tasche auf den
Tisch und lauschte. Irgendwo über ihr knarrte eine Diele. Es war die Art von
Geräusch, die ein altes Haus von allein macht, aber das glaubte sie nicht.
`;

const SPANISH = `
No esperaba que la casa estuviera tan silenciosa. El pasillo estaba oscuro y
la puerta de la cocina seguía abierta, como siempre lo había estado. Nada en
la habitación se había movido desde la última vez que estuvo allí, y eso era
precisamente lo que la asustaba. Dejó el bolso sobre la mesa y escuchó. En
algún lugar por encima de ella crujió una tabla del suelo. Era la clase de
sonido que una casa vieja hace por su cuenta, pero ella no se lo creía.
`;

const FRENCH = `
Elle ne s'attendait pas à ce que la maison soit aussi silencieuse. Le couloir
était sombre, et la porte de la cuisine restait ouverte, comme toujours. Rien
dans la pièce n'avait bougé depuis la dernière fois qu'elle était venue, et
c'était précisément cela qui lui faisait peur. Elle posa son sac sur la table
et écouta. Quelque part au-dessus d'elle, une lame de parquet craqua. C'était
le genre de bruit qu'une vieille maison fait toute seule, mais elle n'y
croyait pas, et elle n'avait aucune envie de monter voir.
`;

// ── language ──

test("English prose is read as English", () => {
  assert.equal(value(detectManuscriptLanguage(ENGLISH)), "en");
});

test("Danish prose is read as Danish", () => {
  assert.equal(value(detectManuscriptLanguage(DANISH)), "da");
});

test("German prose is read as German", () => {
  assert.equal(value(detectManuscriptLanguage(GERMAN)), "de");
});

test("Spanish prose is read as Spanish", () => {
  assert.equal(value(detectManuscriptLanguage(SPANISH)), "es");
});

test("French prose is read as French", () => {
  assert.equal(value(detectManuscriptLanguage(FRENCH)), "fr");
});

test("French does not steal the Romance languages it borders", () => {
  // The French list is curated against Spanish and Portuguese rather than for
  // coverage: "de", "la", "le", "les", "en", "un" and "que" — the commonest
  // French words there are — are exactly what a Spanish or Portuguese novel is
  // full of, so none of them is in it. This is the test that says so.
  assert.equal(value(detectManuscriptLanguage(SPANISH)), "es");
  const portuguese = `
    Ela não esperava que a casa estivesse tão silenciosa. O corredor estava
    escuro e a porta da cozinha continuava aberta, como sempre esteve. Nada no
    quarto tinha se movido desde a última vez que ela estivera ali, e era
    justamente isso que a assustava. Deixou a bolsa sobre a mesa e escutou.
    Em algum lugar acima dela uma tábua do assoalho rangeu. Era o tipo de som
    que uma casa velha faz sozinha, mas ela não acreditava nisso, e não tinha
    nenhuma intenção de subir para ver o que havia lá em cima naquela noite.
  `;
  assertUnsure(
    detectManuscriptLanguage(portuguese),
    "Portuguese must not be pulled into French by the words the two share",
  );
});

test("a title page is too little text to call", () => {
  // Front matter alone must never decide the language of a novel.
  assertUnsure(
    detectManuscriptLanguage("The Quiet House\n\nA Novel\n\nby Anna Bell\n"),
    "a handful of words is not evidence",
  );
});

test("an empty manuscript is unsure, not a crash", () => {
  assertUnsure(detectManuscriptLanguage(""), "no text, no answer");
});

test("a language Betty ships no dictionary for is not forced into one", () => {
  // Italian is not in KNOWN_MANUSCRIPT_LANGS. The honest answer is "unsure",
  // which leaves the author's own "other" selection alone.
  // Deliberately long enough to clear the minimum-length guard, so this tests
  // discrimination rather than the "too short" shortcut.
  const italian = `
    Non si aspettava che la casa fosse così silenziosa. Il corridoio era buio
    e la porta della cucina era rimasta aperta, come sempre. Niente nella
    stanza si era mosso dall ultima volta che era stata qui, ed era proprio
    questo che la spaventava. Posò la borsa sul tavolo e ascoltò a lungo.
    Da qualche parte sopra di lei scricchiolò una tavola del pavimento. Era
    il genere di rumore che una vecchia casa fa da sola, ma lei non ci
    credeva affatto, e non aveva alcuna intenzione di salire al piano di
    sopra per controllare come stavano davvero le cose in quella stanza.
  `;
  assertUnsure(
    detectManuscriptLanguage(italian),
    "Italian shares too little with the five shipped languages to win one",
  );
});

// ── English dialect ──
//
// The 321-pair list in dialect.ts is a CONVERSION corpus: given a known target
// it rewrites correctly. It is not automatically a DETECTION corpus, and the
// tests below pin the two ways that distinction bites.

test("the evidence subset excludes -ise/-ize, which Oxford spelling shares", () => {
  const ised = DIALECT_EVIDENCE.filter((p) =>
    /is(e|es|ed|er|ing|ation|ations)$/.test(p.br),
  );
  assert.deepEqual(
    ised,
    [],
    "OUP and much of British publishing spell it -ize; it proves nothing",
  );
});

test("the evidence subset excludes pairs dialect.ts already calls ambiguous", () => {
  // practise/practice, metre/meter, tyre/tire — flagged one-directional there
  // precisely because one side is a different word, not a different spelling.
  for (const banned of ["practise", "metre", "tyre", "licence", "cheque"]) {
    assert.equal(
      DIALECT_EVIDENCE.some((p) => p.br === banned),
      false,
      `${banned} is ambiguous and must not count as evidence`,
    );
  }
});

test("British spelling is read as British", () => {
  const text = `
    The colour of the harbour that morning was the grey of old defence
    paint. Her neighbour had travelled up from the theatre in the centre of
    town, and it was his favourite story, the one about the jewellery.
  `;
  assert.equal(value(detectEnglishDialect(text)), "british");
});

test("American spelling is read as American", () => {
  const text = `
    The color of the harbor that morning was the gray of old defense paint.
    Her neighbor had traveled up from the theater in the center of town, and
    it was his favorite story, the one about the jewelry.
  `;
  assert.equal(value(detectEnglishDialect(text)), "american");
});

test("British prose using Oxford -ize spelling is still British", () => {
  // The trap. Every -ize here is correct British (OUP house style), and the
  // only real dialect evidence is -our/-re/-ence. A detector that counted
  // -ise/-ize would call this American and rewrite the whole book.
  const text = `
    She began to realize that the colour had changed. They would organize the
    defence themselves, recognize the harbour by its grey light, and apologize
    to the neighbour in the centre of town for the theatre tickets.
  `;
  assert.equal(
    value(detectEnglishDialect(text)),
    "british",
    "Oxford spelling must not be mistaken for American",
  );
});

test("a manuscript that mixes both is unsure rather than guessed", () => {
  // This is the case dialect.ts exists to clean up — one real manuscript
  // shipped with both "Grey" and "Gray". Betty should say she cannot tell.
  const text = `
    The colour of the harbour was grey. The color of the harbor was gray.
    Her neighbour walked to the theatre; her neighbor walked to the theater.
    It was his favourite defence, and also his favorite defense.
  `;
  assertUnsure(detectEnglishDialect(text), "an even split is not an answer");
});

test("prose with no dialect markers at all is unsure", () => {
  const text = `
    She had not expected the house to be so quiet. The hallway was dark and
    the door stood open, as it always had. Nothing in the room had moved
    since the last time she was here, and that was the thing that scared her.
  `;
  assertUnsure(detectEnglishDialect(text), "no markers means no evidence");
});

test("a single stray marker is too thin to decide a whole book", () => {
  assertUnsure(
    detectEnglishDialect("The colour of the door. She went inside and sat."),
    "one word cannot set the dialect for a manuscript",
  );
});

// ── Oxford comma ──
//
// The hard part is not finding commas, it is deciding what is a list. The
// confounder is the compound clause — "He ate, and then he left" puts a comma
// before "and" while listing nothing at all, and counting it would report
// Oxford style in a manuscript that has none.

test("consistent Oxford lists are read as Oxford", () => {
  const text = `
    She packed bread, cheese, and apples. The room held a bed, a chair, and a
    lamp. He spoke of his father, his brother, and the farm. There was dust,
    silence, and the smell of tar. They brought rope, nails, and a hammer.
    The box held letters, photographs, and a ring. She wanted rest, quiet,
    and time. It was cold, wet, and dark. He counted the sheep, the goats,
    and the hens.
  `;
  assert.equal(value(detectOxfordComma(text)), true);
});

test("consistent lists without the final comma are read as no Oxford", () => {
  const text = `
    She packed bread, cheese and apples. The room held a bed, a chair and a
    lamp. He spoke of his father, his brother and the farm. There was dust,
    silence and the smell of tar. They brought rope, nails and a hammer.
    The box held letters, photographs and a ring. She wanted rest, quiet
    and time. It was cold, wet and dark. He counted the sheep, the goats
    and the hens.
  `;
  assert.equal(value(detectOxfordComma(text)), false);
});

test("a compound clause is not mistaken for an Oxford list", () => {
  // Every "and" here is preceded by a comma, and not one of them is a list.
  // A naive detector calls this Oxford style with total confidence.
  const text = `
    He ate, and then he left. She waited by the door, and nobody came.
    The rain stopped, and the street went quiet. He turned the key, and the
    engine caught. She called his name, and the house gave nothing back.
    They walked to the bridge, and they stood there a while. He looked up,
    and the light had gone. She closed the book, and put it on the shelf.
    The bell rang twice, and no one answered it at all.
  `;
  assertUnsure(
    detectOxfordComma(text),
    "commas joining clauses say nothing about list style",
  );
});

test("a manuscript inconsistent about the final comma is unsure", () => {
  const text = `
    She packed bread, cheese, and apples. The room held a bed, a chair and a
    lamp. He spoke of his father, his brother, and the farm. There was dust,
    silence and the smell of tar. They brought rope, nails, and a hammer.
    The box held letters, photographs and a ring. She wanted rest, quiet,
    and time. It was cold, wet and dark. He counted the sheep, the goats,
    and the hens. There were cups, plates and bowls on every single shelf.
  `;
  assertUnsure(detectOxfordComma(text), "half and half is not a house style");
});

test("pairs after a comma do not outvote the serial commas of an Oxford manuscript", () => {
  // Measured on real prose: an Oxford manuscript shows about as many
  // "X, tiny and dense" pairs as it shows lists, and none of them is a
  // list. Four lists with the comma against five such pairs is Oxford.
  const text = `
    The room smelled of salt, tar, and old woodsmoke. Wren cross-referenced
    tide tables, wind charts, and old shipping logs. The letter was polite,
    brief, and entirely reasonable. She packed bread, cheese, and apples.
    There were notes in the margins, tiny and dense. She brought her findings
    to the shop the next morning, breathless and certain. Elizabeth, easy and
    unaffected, said nothing. Collins, awkward and solemn, bowed. She thought
    about the cardiology unit, briefly and without much feeling.
  `;
  assert.equal(value(detectOxfordComma(text)), true);
});

test("one stray serial comma does not unsettle a no-Oxford manuscript", () => {
  const text = `
    She packed bread, cheese and apples. The room held a bed, a chair and a
    lamp. He spoke of his father, his brother and the farm. There was dust,
    silence and the smell of tar. They brought rope, nails and a hammer.
    The box held letters, photographs and a ring. It was cold, wet, and dark.
  `;
  assert.equal(value(detectOxfordComma(text)), false);
});

test("clause tails with a comma before the conjunction are not serial commas", () => {
  // Each of these puts a comma before "and" after two short segments, and
  // not one is a list: the segment before the conjunction is a clause.
  const text = `
    Outside, the rain eased, and a thin light came. Of course she wouldn't,
    Ines thought, and did not say. Ines told them nothing, at some length,
    and they went away satisfied. He looked up, the door closed, and nobody
    spoke. She waited, it was late, and the house was still.
  `;
  assertUnsure(detectOxfordComma(text), "clauses are not lists");
});

test("prose containing no lists at all is unsure", () => {
  assertUnsure(
    detectOxfordComma(ENGLISH),
    "no lists means nothing to count",
  );
});

test("a couple of lists is too thin to set a house style", () => {
  assertUnsure(
    detectOxfordComma("She packed bread, cheese, and apples. It was cold, wet, and dark."),
    "two lists is not a convention",
  );
});

// ── Introductory comma ──
//
// The setting is about the OPTIONAL comma ("Finally, she looked up" versus
// "Finally she looked up"). Connectives like "However" and "Nevertheless"
// take a comma under every house style, so counting them measures English
// rather than the author, and drowns the signal that actually matters.

test("an author who always sets off the opener is read as using it", () => {
  const text = `
    Suddenly, the door gave way. Slowly, she climbed the stairs. Later, the
    rain began. Quietly, he set down the lamp. Eventually, someone spoke.
    Outside, the wind had dropped. Carefully, she lifted the lid. Finally,
    the noise stopped. Soon, the room was warm. Gently, he closed the door.
    Afterwards, nobody mentioned it.
  `;
  assert.equal(value(detectIntroductoryComma(text)), true);
});

test("an author who runs straight on is read as not using it", () => {
  const text = `
    Suddenly the door gave way. Slowly she climbed the stairs. Later the
    rain began. Quietly he set down the lamp. Eventually someone spoke.
    Outside the wind had dropped. Carefully she lifted the lid. Finally
    the noise stopped. Soon the room was warm. Gently he closed the door.
    Afterwards nobody mentioned it.
  `;
  assert.equal(value(detectIntroductoryComma(text)), false);
});

test("obligatory connectives are not counted as the author's choice", () => {
  // "However," takes its comma in every style. A manuscript whose only
  // openers are these has told us nothing about the optional comma.
  const text = `
    However, the door was locked. Nevertheless, she tried it twice.
    Therefore, the plan changed. Moreover, the light had gone out.
    Furthermore, nobody had a key. Consequently, they waited outside.
    Indeed, the whole night passed. Nevertheless, the morning came.
    However, nothing had changed. Therefore, they went home again.
  `;
  assertUnsure(
    detectIntroductoryComma(text),
    "these commas are grammar, not house style",
  );
});

test("a manuscript inconsistent about the opener is unsure", () => {
  const text = `
    Suddenly, the door gave way. Slowly she climbed the stairs. Later, the
    rain began. Quietly he set down the lamp. Eventually, someone spoke.
    Outside the wind had dropped. Carefully, she lifted the lid. Finally
    the noise stopped. Soon, the room was warm. Gently he closed the door.
  `;
  assertUnsure(detectIntroductoryComma(text), "an even split is not a style");
});

test("prose that never opens on an adverb is unsure", () => {
  assertUnsure(detectIntroductoryComma(ENGLISH), "nothing to count");
});

// ── Danish comma ──
//
// Both systems are correct Danish and Retskrivningsordbogen sanctions each, so
// guessing wrong is guessing about the author rather than about grammar. The
// discriminator is the comma before a subordinate clause: grammatisk komma
// sets one, nyt komma does not.
//
// The trap is "at". As a conjunction it opens a clause ("hun vidste, at han
// kom"); as an infinitive marker it opens nothing ("hun begyndte at løbe") and
// never takes a comma under either system. Infinitives are far more common, so
// counting them would report nyt komma for every Danish manuscript alike.

test("commas before subordinate clauses are read as grammatisk komma", () => {
  const text = `
    Hun vidste, at han ville komme. Han sagde, at det var forbi. Jeg tror, at
    de er gået hjem. Vi håbede, at hun kom tilbage. Han mente, at det var en
    fejl. Hun så, at der var lys i vinduet. Det var svært, fordi han var
    træt. De blev hjemme, fordi det regnede hele dagen. Hun spurgte, hvorfor
    han kom for sent. Han vidste ikke, hvornår toget kom. Vi ventede, mens de
    spiste. Hun læste videre, mens han sov. Han kom ikke, hvis det regnede.
    Jeg bliver her, indtil du er klar til at gå.
  `;
  assert.equal(value(detectDanishComma(text)), "grammatisk");
});

test("no commas before subordinate clauses is read as nyt komma", () => {
  const text = `
    Hun vidste at han ville komme. Han sagde at det var forbi. Jeg tror at
    de er gået hjem. Vi håbede at hun kom tilbage. Han mente at det var en
    fejl. Hun så at der var lys i vinduet. Det var svært fordi han var
    træt. De blev hjemme fordi det regnede hele dagen. Hun spurgte hvorfor
    han kom for sent. Han vidste ikke hvornår toget kom. Vi ventede mens de
    spiste. Hun læste videre mens han sov. Han kom ikke hvis det regnede.
    Jeg bliver her indtil du er klar til at gå.
  `;
  assert.equal(value(detectDanishComma(text)), "nyt");
});

test("the infinitive at is not mistaken for a subordinate clause", () => {
  // Twelve infinitives, not one subordinate clause, and not one comma. A
  // detector that counted every "at" would call this nyt komma outright.
  const text = `
    Hun begyndte at løbe ned ad vejen. Han prøvede at åbne døren. De holdt
    op med at tale sammen. Hun var nødt til at vente meget længe. Han glemte
    at lukke vinduet. De forsøgte at finde vej hjem. Hun nægtede at svare på
    det. Han lovede at komme igen i morgen. De ønskede at blive der. Hun
    turde ikke at spørge om det. Han valgte at gå sin vej. De besluttede at
    rejse bort for altid.
  `;
  assertUnsure(
    detectDanishComma(text),
    "infinitive markers say nothing about comma style",
  );
});

test("a subordinate clause that opens the sentence is not evidence", () => {
  // Both systems put the comma AFTER a leading subordinate clause, so these
  // sentences are identical under grammatisk and nyt komma alike.
  const text = `
    Hvis det regner, bliver vi hjemme. Fordi han var træt, gik han i seng.
    Mens de spiste, ringede telefonen. Når hun kommer, går vi straks.
    Hvis du vil, kan vi tage af sted. Fordi det var sent, tog de en taxa.
    Mens han sov, ryddede hun op. Når toget kommer, skal vi skynde os.
    Hvis han spørger, siger vi ingenting. Fordi vejret var dårligt, blev de.
    Mens vi ventede, læste hun avisen. Når det bliver mørkt, tænder vi lys.
  `;
  assertUnsure(
    detectDanishComma(text),
    "a leading clause takes its comma under both systems",
  );
});

test("a manuscript inconsistent about the comma is unsure", () => {
  const text = `
    Hun vidste, at han ville komme. Han sagde at det var forbi. Jeg tror, at
    de er gået hjem. Vi håbede at hun kom tilbage. Han mente, at det var en
    fejl. Hun så at der var lys i vinduet. Det var svært, fordi han var
    træt. De blev hjemme fordi det regnede hele dagen. Hun spurgte, hvorfor
    han kom for sent. Han vidste ikke hvornår toget kom. Vi ventede, mens de
    spiste. Hun læste videre mens han sov.
  `;
  assertUnsure(detectDanishComma(text), "half and half is not a system");
});

// ── The whole pass ──
//
// Language is detected first and decides what else is even asked. A German
// manuscript is never questioned about the Oxford comma, and an English one
// is never questioned about Danish comma systems — the absent keys are how
// the UI knows not to render a badge at all.

const BRITISH_NOVEL = `
Suddenly, the colour drained out of the harbour. She packed bread, cheese,
and apples. Slowly, her neighbour crossed the grey yard towards the theatre
in the centre of town. The room held a bed, a chair, and a lamp. Later, he
spoke of his father, his brother, and the farm. Quietly, she set down dust,
silence, and the smell of tar. Carefully, they brought rope, nails, and a
hammer. Outside, the box held letters, photographs, and a ring. Finally,
she wanted rest, quiet, and time. Eventually, it was cold, wet, and dark.
Gently, he counted the sheep, the goats, and the hens. Soon, the defence
had travelled past his favourite jewellery shop. Afterwards, nobody spoke.
`;

test("an English manuscript is asked the English questions only", () => {
  const d = detectSettings(BRITISH_NOVEL);
  assert.equal(value(d.manuscriptLang!), "en");
  assert.equal(value(d.englishDialect!), "british");
  assert.equal(value(d.oxfordComma!), true);
  assert.equal(value(d.introductoryComma!), true);
  assert.equal(d.danishComma, undefined, "not a Danish question");
});

test("a Danish manuscript is asked the Danish question only", () => {
  const text = `
    Hun vidste, at han ville komme. Han sagde, at det var forbi. Jeg tror, at
    de er gået hjem. Vi håbede, at hun kom tilbage. Han mente, at det var en
    fejl. Hun så, at der var lys i vinduet. Det var svært, fordi han var
    træt. De blev hjemme, fordi det regnede hele dagen. Hun spurgte, hvorfor
    han kom for sent. Han vidste ikke, hvornår toget kom. Vi ventede, mens de
    spiste. Hun læste videre, mens han sov. Han kom ikke, hvis det regnede.
    Jeg bliver her, indtil du er klar til at gå med os alle sammen.
  `;
  const d = detectSettings(text);
  assert.equal(value(d.manuscriptLang!), "da");
  assert.equal(value(d.danishComma!), "grammatisk");
  assert.equal(d.englishDialect, undefined, "not an English question");
  assert.equal(d.oxfordComma, undefined, "not an English question");
  assert.equal(d.introductoryComma, undefined, "not an English question");
});

test("a German manuscript is asked nothing beyond its language", () => {
  const d = detectSettings(GERMAN);
  assert.equal(value(d.manuscriptLang!), "de");
  assert.equal(d.englishDialect, undefined);
  assert.equal(d.oxfordComma, undefined);
  assert.equal(d.introductoryComma, undefined);
  assert.equal(d.danishComma, undefined);
});

test("an unidentified language leaves every other setting alone", () => {
  // Betty must not run English rules over a manuscript she could not place.
  const d = detectSettings("The Quiet House\n\nA Novel\n");
  assert.equal(d.manuscriptLang!.status, "unsure");
  assert.equal(d.englishDialect, undefined);
  assert.equal(d.oxfordComma, undefined);
  assert.equal(d.danishComma, undefined);
});

test("a full-length manuscript is detected without a noticeable pause", () => {
  // This runs inside the upload request, so it has to stay cheap.
  const novel = BRITISH_NOVEL.repeat(2000); // ~1.4M characters
  const started = process.hrtime.bigint();
  const d = detectSettings(novel);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(value(d.manuscriptLang!), "en");
  assert.ok(ms < 1000, `detection took ${ms.toFixed(0)}ms, expected well under 1s`);
});
