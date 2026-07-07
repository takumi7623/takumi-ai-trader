import type { Stock } from "./types";

export const mockStocks: Stock[] = [
  {
    code: "7203",
    name: "トヨタ自動車",
    sector: "輸送用機器",
    baselineTrend: "up",
    description:
      "大型株として流動性が高く、為替と世界販売動向の影響を受けやすい銘柄です。",
  },
  {
    code: "6758",
    name: "ソニーグループ",
    sector: "電気機器",
    baselineTrend: "neutral",
    description:
      "ゲーム、音楽、半導体など複数事業を持ち、事業別材料の確認が重要です。",
  },
  {
    code: "9984",
    name: "ソフトバンクグループ",
    sector: "情報・通信",
    baselineTrend: "volatile",
    description:
      "投資先評価や外部市場の影響を受けやすく、値動きが大きくなりやすい銘柄です。",
  },
  {
    code: "8306",
    name: "三菱UFJフィナンシャル・グループ",
    sector: "銀行業",
    baselineTrend: "steady",
    description:
      "金利環境や金融セクター全体の地合いと合わせて確認したい銘柄です。",
  },
];

export function findMockStock(query: string) {
  const normalizedQuery = query.trim().toLowerCase();

  return mockStocks.find((stock) => {
    return (
      stock.code === normalizedQuery ||
      stock.name.toLowerCase().includes(normalizedQuery)
    );
  });
}
