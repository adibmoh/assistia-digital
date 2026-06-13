const translations = {
  fr: {
    nav_home: 'Accueil', nav_about: 'À propos', nav_guides: 'Guides', nav_example: 'Exemple', nav_faq: 'FAQ', nav_contact: 'Contact', nav_privacy: 'Confidentialité', nav_terms: 'Conditions',
    hero_title: 'Assist <span>AI</span>', hero_tagline: 'Des outils intelligents pour des décisions plus claires', reviewpro: 'ReviewPro', features: 'Voir les fonctionnalités',
    home_intro_title: 'Comprendre la réputation locale avant de décider', home_intro_text: 'Assist AI transforme les avis Google, les notes et les comparaisons locales en informations claires pour les propriétaires, managers et responsables qui veulent améliorer leur service.',
    launch: 'Lancer ReviewPro'
  },
  en: {
    nav_home: 'Home', nav_about: 'About', nav_guides: 'Guides', nav_example: 'Example', nav_faq: 'FAQ', nav_contact: 'Contact', nav_privacy: 'Privacy', nav_terms: 'Terms',
    hero_title: 'Assist <span>AI</span>', hero_tagline: 'Smart tools for clearer decisions', reviewpro: 'ReviewPro', features: 'See the features',
    home_intro_title: 'Understand local reputation before making decisions', home_intro_text: 'Assist AI turns Google reviews, ratings and local comparisons into clear insights for owners, managers and decision-makers who want to improve their service.',
    launch: 'Launch ReviewPro'
  },
  de: {
    nav_home: 'Startseite', nav_about: 'Über uns', nav_guides: 'Guides', nav_example: 'Beispiel', nav_faq: 'FAQ', nav_contact: 'Kontakt', nav_privacy: 'Datenschutz', nav_terms: 'Bedingungen',
    hero_title: 'Assist <span>AI</span>', hero_tagline: 'Intelligente Tools für klarere Entscheidungen', reviewpro: 'ReviewPro', features: 'Funktionen ansehen',
    home_intro_title: 'Lokale Reputation verstehen, bevor Sie entscheiden', home_intro_text: 'Assist AI verwandelt Google-Bewertungen, Noten und lokale Vergleiche in klare Erkenntnisse für Inhaber, Manager und Entscheidungsträger.',
    launch: 'ReviewPro starten'
  },
  es: {
    nav_home: 'Inicio', nav_about: 'Acerca de', nav_guides: 'Guías', nav_example: 'Ejemplo', nav_faq: 'FAQ', nav_contact: 'Contacto', nav_privacy: 'Privacidad', nav_terms: 'Términos',
    hero_title: 'Assist <span>AI</span>', hero_tagline: 'Herramientas inteligentes para decisiones más claras', reviewpro: 'ReviewPro', features: 'Ver funcionalidades',
    home_intro_title: 'Comprender la reputación local antes de decidir', home_intro_text: 'Assist AI convierte reseñas de Google, valoraciones y comparaciones locales en información clara para propietarios, gerentes y responsables.',
    launch: 'Abrir ReviewPro'
  },
  ar: {
    nav_home: 'الرئيسية', nav_about: 'حول', nav_guides: 'الأدلة', nav_example: 'مثال', nav_faq: 'الأسئلة', nav_contact: 'اتصال', nav_privacy: 'الخصوصية', nav_terms: 'الشروط',
    hero_title: 'Assist <span>AI</span>', hero_tagline: 'أدوات ذكية لقرارات أوضح', reviewpro: 'ReviewPro', features: 'عرض الميزات',
    home_intro_title: 'فهم السمعة المحلية قبل اتخاذ القرار', home_intro_text: 'يحوّل Assist AI مراجعات Google والتقييمات والمقارنات المحلية إلى رؤى واضحة للمالكين والمديرين وصنّاع القرار.',
    launch: 'تشغيل ReviewPro'
  },
  zh: {
    nav_home: '首页', nav_about: '关于', nav_guides: '指南', nav_example: '示例', nav_faq: '常见问题', nav_contact: '联系', nav_privacy: '隐私', nav_terms: '条款',
    hero_title: 'Assist <span>AI</span>', hero_tagline: '让决策更清晰的智能工具', reviewpro: 'ReviewPro', features: '查看功能',
    home_intro_title: '在决策前理解本地声誉', home_intro_text: 'Assist AI 将 Google 评论、评分和本地比较转化为清晰见解，帮助所有者、经理和决策者改进服务。',
    launch: '打开 ReviewPro'
  },
  hi: {
    nav_home: 'होम', nav_about: 'परिचय', nav_guides: 'गाइड', nav_example: 'उदाहरण', nav_faq: 'FAQ', nav_contact: 'संपर्क', nav_privacy: 'गोपनीयता', nav_terms: 'शर्तें',
    hero_title: 'Assist <span>AI</span>', hero_tagline: 'बेहतर निर्णयों के लिए स्मार्ट टूल्स', reviewpro: 'ReviewPro', features: 'फ़ीचर देखें',
    home_intro_title: 'निर्णय लेने से पहले स्थानीय प्रतिष्ठा समझें', home_intro_text: 'Assist AI Google समीक्षाओं, रेटिंग और स्थानीय तुलना को मालिकों, प्रबंधकों और निर्णयकर्ताओं के लिए स्पष्ट जानकारी में बदलता है।',
    launch: 'ReviewPro खोलें'
  }
};
function applyLang(lang){
  const data = translations[lang] || translations.fr;
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  document.querySelectorAll('[data-i18n]').forEach(el=>{
    const key = el.getAttribute('data-i18n');
    if(data[key]) el.innerHTML = data[key];
  });
  document.querySelectorAll('[data-lang]').forEach(btn=>{
    btn.classList.toggle('active', btn.getAttribute('data-lang')===lang);
  });
  localStorage.setItem('assistai_lang', lang);
}
document.addEventListener('DOMContentLoaded',()=>{
  const stored = localStorage.getItem('assistai_lang') || 'fr';
  applyLang(stored);
  document.querySelectorAll('[data-lang]').forEach(btn=>btn.addEventListener('click',()=>applyLang(btn.getAttribute('data-lang'))));
});
