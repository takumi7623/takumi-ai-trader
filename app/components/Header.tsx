export default function Header() {
  return (
    <header className="w-full bg-gray-900 text-white shadow-lg border-b border-gray-700">
      <div className="max-w-7xl mx-auto px-6 py-5 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-cyan-400">
            TAKUMI AI TRADER
          </h1>

          <p className="text-gray-400 text-sm mt-1">
            日本株 AI分析システム Ver1.0
          </p>
        </div>

        <div className="text-right">
          <div className="text-green-400 font-bold">
            AI READY
          </div>

          <div className="text-xs text-gray-400">
            Japanese Stock Market
          </div>
        </div>
      </div>
    </header>
  );
}