import { useRef, useState } from 'react';
import { Bot, Send, Sparkles, Film, Search, Languages, WandSparkles, Loader2, User } from 'lucide-react';
import { getAIService } from '@/services/ai/AIService';
import type { Movie } from '@/types/movie';

type Message = { role: 'user' | 'assistant'; content: string };

export default function AIAssistantView({ movies }: { movies: Movie[] }) {
  const [messages, setMessages] = useState<Message[]>([{ role: 'assistant', content: 'سلام! من دستیار هوشمند فیلم‌باز هستم. می‌توانم دربارهٔ فیلم‌ها و سریال‌های کتابخانه‌ات راهنمایی کنم، آثار مشابه پیشنهاد بدهم یا متن زیرنویس را ترجمه کنم.' }]);
  const [input, setInput] = useState('');
  const [subtitle, setSubtitle] = useState('');
  const [busy, setBusy] = useState(false);
  const libraryContext = useMemo(() => movies.slice(0, 100).map((m) => `${m.title} (${m.englishTitle}, ${m.year}) | ژانر: ${m.genres.join('، ')} | خلاصه: ${m.synopsis}`).join('\n'), [movies]);

  async function ask(text: string, systemPrompt?: string) {
    const prompt = text.trim();
    if (!prompt || busy) return;
    setMessages((old) => [...old, { role: 'user', content: prompt }]);
    setInput(''); setBusy(true);
    try {
      const response = await getAIService().chat({
        systemPrompt: systemPrompt || `تو دستیار فارسی‌زبان برنامه FILM BAZ هستی. پاسخ‌ها دقیق، دوستانه و فارسی باشند. اگر اطلاعات کافی نداری صادقانه بگو. از این کتابخانه برای پیشنهادها استفاده کن و فیلمی را که در فهرست نیست به‌عنوان موجود در کتابخانه معرفی نکن:\n${libraryContext || 'کتابخانه هنوز خالی است.'}`,
        userPrompt: prompt, maxTokens: 1200, temperature: 0.6,
      });
      setMessages((old) => [...old, { role: 'assistant', content: response.content || 'پاسخی دریافت نشد.' }]);
    } catch (error) {
      setMessages((old) => [...old, { role: 'assistant', content: `خطا در دریافت پاسخ: ${error instanceof Error ? error.message : 'اتصال ناموفق بود'}. تنظیمات هوش مصنوعی و فعال بودن ارائه‌دهنده را بررسی کن.` }]);
    } finally { requestController.current = null; setBusy(false); }
  }

  function stopRequest() {
    requestController.current?.abort();
  }

  return <section className="mx-auto max-w-5xl px-4 py-8" dir="rtl">
    <div className="mb-6 flex items-center gap-3"><div className="rounded-xl bg-gold/15 p-3 text-gold-bright"><Bot size={28}/></div><div><h1 className="text-2xl font-extrabold text-white">دستیار هوشمند فیلم‌باز</h1><p className="text-sm text-text-muted">گفت‌وگو، پیشنهاد فیلم و ترجمهٔ زیرنویس با مدل متصل‌شده</p></div></div>
    <div className="mb-4 flex flex-wrap gap-2">
      <button className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-text-secondary hover:bg-white/10 inline-flex items-center gap-2" onClick={() => void ask('با توجه به سلیقه و فهرست کتابخانه‌ام چند فیلم برای تماشا پیشنهاد بده. برای هرکدام دلیل کوتاهی بنویس.')}><Sparkles size={16}/> پیشنهاد فیلم</button>
      <button className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-text-secondary hover:bg-white/10 inline-flex items-center gap-2" onClick={() => void ask('فیلم‌های مشابه آثار موجود در کتابخانه‌ام را معرفی کن و دلیل شباهت را توضیح بده.')}><Film size={16}/> فیلم‌های مشابه</button>
      <button className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-text-secondary hover:bg-white/10 inline-flex items-center gap-2" onClick={() => void ask('برای خلاصه‌سازی یک فیلم یا سریال آماده‌ام؛ از من نام اثر را بپرس و خلاصه‌ای بدون اسپویل ارائه کن.')}><WandSparkles size={16}/> خلاصهٔ بدون اسپویل</button>
      <button className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-text-secondary hover:bg-white/10 inline-flex items-center gap-2" onClick={() => void ask('راهنمای جست‌وجوی هوشمند: می‌خواهم با توصیف داستان یا نام بازیگر فیلمی پیدا کنم.')}><Search size={16}/> جست‌وجوی توصیفی</button>
    </div>
    <div className="rounded-2xl border border-white/10 bg-surface-2 p-4 sm:p-6">
      <div className="mb-4 max-h-[430px] min-h-64 space-y-4 overflow-y-auto" aria-live="polite">
        {messages.map((m, i) => <div key={i} className={`flex gap-2 ${m.role === 'user' ? 'justify-start' : 'justify-start'}`}><span className="mt-1 text-gold-bright">{m.role === 'user' ? <User size={18}/> : <Bot size={18}/>}</span><div className={`max-w-[90%] whitespace-pre-wrap rounded-xl px-4 py-3 text-sm leading-7 ${m.role === 'user' ? 'bg-white/10 text-white' : 'bg-black/20 text-text-secondary'}`}>{m.content}</div></div>)}
        {busy && <div className="flex items-center gap-3 text-sm text-text-muted"><Loader2 className="animate-spin" size={16}/> در حال دریافت پاسخ… <button type="button" onClick={stopRequest} className="rounded-lg border border-red-400/30 px-3 py-1 text-red-300">توقف پردازش</button></div>}
      </div>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void ask(input); }}><input value={input} onChange={(e) => setInput(e.target.value)} placeholder="مثلاً یک فیلم معمایی و کم‌خشونت پیشنهاد بده…" className="min-w-0 flex-1 rounded-xl border border-white/10 bg-base px-4 py-3 text-sm text-white outline-none focus:border-gold/50"/><button disabled={busy || !input.trim()} className="btn-primary inline-flex items-center gap-2 disabled:opacity-50"><Send size={16}/> ارسال</button></form>
    </div>
    <div className="mt-6 rounded-2xl border border-white/10 bg-surface-2 p-4 sm:p-6">
      <div className="mb-3 flex items-center gap-2 text-white"><Languages size={19} className="text-gold-bright"/><h2 className="font-bold">ترجمهٔ زیرنویس به فارسی</h2></div>
      <p className="mb-3 text-xs text-text-muted">متن زیرنویس را وارد کن. برای متن‌های طولانی، آن را در چند بخش ترجمه کن تا محدودیت درخواست رعایت شود.</p>
      <textarea value={subtitle} onChange={(e) => setSubtitle(e.target.value)} rows={5} placeholder={'1\n00:00:01,000 --> 00:00:03,000\nHello, welcome back.'} className="w-full rounded-xl border border-white/10 bg-base p-3 text-sm text-white outline-none focus:border-gold/50"/>
      <button disabled={busy || !subtitle.trim()} onClick={() => void ask(`متن زیرنویس زیر را به فارسی روان ترجمه کن. شماره‌ها و زمان‌بندی SRT را دقیقاً حفظ کن و فقط متن دیالوگ‌ها را ترجمه کن:\n\n${subtitle}`, 'تو مترجم حرفه‌ای زیرنویس هستی. متن را به فارسی طبیعی ترجمه کن. شماره‌گذاری و timestampها را بدون هیچ تغییری حفظ کن و فقط دیالوگ‌ها را ترجمه کن. خروجی را فقط به شکل زیرنویس بده.')} className="btn-primary mt-3 inline-flex items-center gap-2 disabled:opacity-50"><WandSparkles size={16}/> ترجمهٔ زیرنویس</button>
    </div>
  </section>;
}
