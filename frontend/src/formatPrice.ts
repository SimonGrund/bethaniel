// How a cloud price is written.
//
// The Worker quotes Americans in dollars, Danes in kroner and everyone else in
// euros, at set prices ($5.99, 39 kr., EUR 5). A dollar or krone price is
// written the way that country writes it whatever language the app is in, so a
// Dane with the app in English still reads "39 kr." rather than "DKK 39.00".
// A euro price follows the app's language, since euro countries disagree
// ("€5" in English, "5 €" in Danish, German, French and Spanish).
//
// Whole amounts drop the decimals: "39 kr.", "€5", but "$5.99".

const LOCALE_FOR_CURRENCY: Record<string, string> = {
  USD: "en-US",
  DKK: "da-DK",
};

export function formatPrice(cents: number, currency: string | undefined, uiLang: string): string {
  const code = (currency || "EUR").toUpperCase();
  const whole = cents % 100 === 0;
  try {
    return new Intl.NumberFormat(LOCALE_FOR_CURRENCY[code] ?? uiLang, {
      style: "currency",
      currency: code,
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: whole ? 0 : 2,
    }).format(cents / 100);
  } catch {
    // An unknown language tag or currency code: still say the amount.
    return `${(cents / 100).toFixed(whole ? 0 : 2)} ${code}`;
  }
}
