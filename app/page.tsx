import Header from "./components/Header";
import SearchBox from "./components/SearchBox";

export default function Home() {
  return (
    <main className="min-h-screen bg-gray-950">
      <Header />
      <SearchBox />

      <section className="max-w-7xl mx-auto p-8">
        <h2 className="text-4xl font-bold text-white mb-4">
          TAKUMI AI TRADER
        </h2>

        <p className="text-gray-400">
          日本株専用のAIスコア分析画面です。
        </p>

        <div className="mt-10 rounded-xl bg-gray-900 p-8 border border-gray-700">
          <h3 className="text-2xl text-cyan-400 font-bold">
            Ver1.0 開発中
          </h3>

          <p className="text-gray-300 mt-4">
            この画面では、銘柄検索からAIスコアと売買判定を確認できます。
          </p>

          <ul className="mt-4 text-gray-300 space-y-2">
            <li>日本株検索</li>
            <li>AIスコア表示</li>
            <li>買い・売り・保留判定</li>
            <li>トレンド確認</li>
            <li>ニュース分析連携予定</li>
            <li>日経平均・ドル円連携予定</li>
          </ul>
        </div>
      </section>
    </main>
  );
}
