
/**
 * Shruti — Vedic Video Recitation Studio
 * File: src/lib/recitation.ts
 *
 * संस्कृत/हिंदी पाठ को क्रमिक वाचन-इकाइयों में बाँटता है।
 * मूल पाठ को यह फ़ंक्शन बदलता नहीं है।
 */

/**
 * दिए गए पाठ को वाचन की अलग-अलग पंक्तियों में बाँटें।
 *
 * नियम:
 * 1. प्रत्येक स्पष्ट newline एक नई वाचन इकाई शुरू करती है।
 * 2. एक ही पैराग्राफ में ।, ॥, ., ! और ? पर पंक्ति समाप्त होती है।
 * 3. विराम-चिह्न उसी पंक्ति के साथ रहता है।
 * 4. खाली पंक्तियों और अतिरिक्त बाहरी spaces को अनदेखा किया जाता है।
 * 5. Unicode NFC normalization से पाठ का canonical रूप सामान्य किया जाता है।
 *
 * उदाहरण:
 * "ॐ नमः।\nशिवाय॥"
 * => ["ॐ नमः।", "शिवाय॥"]
 *
 * "पहली पंक्ति। दूसरी पंक्ति॥"
 * => ["पहली पंक्ति।", "दूसरी पंक्ति॥"]
 */
export function splitRecitationLines(value: string): string[] {
  if (typeof value !== 'string' || value.length === 0) {
    return [];
  }

  const paragraphs = value
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const lines: string[] = [];

  for (const paragraph of paragraphs) {
    // विराम-चिह्न को उससे पहले आने वाले शब्दों के साथ रखें।
    const chunks = paragraph.match(/[^।॥.!?]+(?:[।॥.!?]+|$)/gu);

    // यदि कोई समर्थित विराम-चिह्न नहीं है, तो पूरा पैराग्राफ एक इकाई है।
    const candidates = chunks?.length ? chunks : [paragraph];

    for (const chunk of candidates) {
      const clean = chunk.trim();

      if (clean.length > 0) {
        lines.push(clean);
      }
    }
  }

  return lines;
}
