export interface WordItem {
  id: string;
  word: string;
  bangla: string;
  category: string;
  hasBundledAudio: boolean;
  isFromUserScreenshotUploadBatch?: boolean;
}

export function toWordId(word: string): string {
  return word
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
}

/**
 * The 14 words shown in the user's "My uploads (14)" screenshot (11 from Missing + 3 overriding Bundled = 128 Missing left).
 */
export const SCREENSHOT_14_UPLOADS: Array<{
  word: string;
  bangla: string;
  category: string;
  wasBundled: boolean;
}> = [
  { word: 'orienteering', bangla: 'দিকনির্দেশনা প্রতিযোগিতা (ওরিয়েন্টিয়ারিং)', category: 'Sports & Outdoor', wasBundled: false },
  { word: 'caving', bangla: 'গুহা অভিযান', category: 'Sports & Outdoor', wasBundled: false },
  { word: 'scuba-diving', bangla: 'স্কুবা ডাইভিং', category: 'Sports & Outdoor', wasBundled: false },
  { word: 'snorkeling', bangla: 'স্নোরকেলিং (পানির নিচে সাঁতার)', category: 'Sports & Outdoor', wasBundled: false },
  { word: 'white-water rafting', bangla: 'খরস্রোতা নদীতে র‍্যাফটিং', category: 'Sports & Outdoor', wasBundled: false },
  { word: 'abseiling', bangla: 'দড়ি বেয়ে পাহাড় থেকে নামা', category: 'Sports & Outdoor', wasBundled: false },
  { word: 'paragliding', bangla: 'প্যারাগ্লাইডিং', category: 'Sports & Outdoor', wasBundled: false },
  { word: 'mountaineering', bangla: 'পর্বতারোহণ', category: 'Sports & Outdoor', wasBundled: false },
  { word: 'bungee jumping', bangla: 'বাঞ্জি জাম্পিং', category: 'Sports & Outdoor', wasBundled: false },
  { word: 'windsurfing', bangla: 'উইন্ডসার্ফিং', category: 'Sports & Outdoor', wasBundled: false },
  { word: 'kayaking', bangla: 'কায়াকিং (ছোট নৌকা চালনা)', category: 'Sports & Outdoor', wasBundled: false },
  { word: 'archery', bangla: 'তীরন্দাজি', category: 'Sports & Outdoor', wasBundled: true },
  { word: 'trekking', bangla: 'দুর্গম পথে হাঁটা বা ট্রেকিং', category: 'Sports & Outdoor', wasBundled: true },
  { word: 'athletics', bangla: 'অ্যাথলেটিক্স বা শরীরচর্চা খেলাধুলা', category: 'Sports & Outdoor', wasBundled: true },
];

/**
 * Core missing IELTS Listening multi-word phrases and high-priority vocabulary
 * ordered to match Screenshot 1 ("weekdays", "annual fee", "monthly membership", "tuition fees", ...).
 */
const PRIORITY_MISSING_WORDS: Array<{ word: string; bangla: string; category: string }> = [
  { word: 'weekdays', bangla: 'কর্মদিবস', category: 'Days & Time' },
  { word: 'annual fee', bangla: 'বার্ষিক ফি', category: 'Finance & Membership' },
  { word: 'monthly membership', bangla: 'মাসিক সদস্যপদ', category: 'Finance & Membership' },
  { word: 'tuition fees', bangla: 'টিউশন ফি / শিক্ষা খরচ', category: 'Academic & Education' },
  { word: 'registration fee', bangla: 'নিবন্ধন ফি', category: 'Finance & Membership' },
  { word: 'orienteering', bangla: 'দিকনির্দেশনা প্রতিযোগিতা (ওরিয়েন্টিয়ারিং)', category: 'Sports & Outdoor' },
  { word: 'caving', bangla: 'গুহা অভিযান', category: 'Sports & Outdoor' },
  { word: 'scuba-diving', bangla: 'স্কুবা ডাইভিং', category: 'Sports & Outdoor' },
  { word: 'snorkeling', bangla: 'স্নোরকেলিং (পানির নিচে সাঁতার)', category: 'Sports & Outdoor' },
  { word: 'white-water rafting', bangla: 'খরস্রোতা নদীতে র‍্যাফটিং', category: 'Sports & Outdoor' },
  { word: 'abseiling', bangla: 'দড়ি বেয়ে পাহাড় থেকে নামা', category: 'Sports & Outdoor' },
  { word: 'paragliding', bangla: 'প্যারাগ্লাইডিং', category: 'Sports & Outdoor' },
  { word: 'mountaineering', bangla: 'পর্বতারোহণ', category: 'Sports & Outdoor' },
  { word: 'bungee jumping', bangla: 'বাঞ্জি জাম্পিং', category: 'Sports & Outdoor' },
  { word: 'windsurfing', bangla: 'উইন্ডসার্ফিং', category: 'Sports & Outdoor' },
  { word: 'kayaking', bangla: 'কায়াকিং (ছোট নৌকা চালনা)', category: 'Sports & Outdoor' },
  { word: 'cancellation policy', bangla: 'বাতিলকরণ নীতি', category: 'Finance & Membership' },
  { word: 'refundable deposit', bangla: 'ফেরতযোগ্য জামানত', category: 'Finance & Membership' },
  { word: 'direct debit', bangla: 'সরাসরি ব্যাংক কর্তন', category: 'Finance & Membership' },
  { word: 'bank transfer', bangla: 'ব্যাংক ট্রান্সফার', category: 'Finance & Membership' },
  { word: 'student discount', bangla: 'শিক্ষার্থী ছাড়', category: 'Finance & Membership' },
  { word: 'renewal date', bangla: 'নবায়নের তারিখ', category: 'Days & Time' },
  { word: 'opening hours', bangla: 'খোলার সময়সূচি', category: 'Days & Time' },
  { word: 'public holiday', bangla: 'সরকারি ছুটির দিন', category: 'Days & Time' },
  { word: 'fortnight', bangla: 'দুই সপ্তাহ (পনেরো দিন)', category: 'Days & Time' },
  { word: 'millennium', bangla: 'সহস্রাব্দ (এক হাজার বছর)', category: 'Days & Time' },
  { word: 'commencement', bangla: 'সমাবর্তন বা শুরু', category: 'Academic & Education' },
  { word: 'dissertation', bangla: 'গবেষণাপত্র / অভিসন্দর্ভ', category: 'Academic & Education' },
  { word: 'curriculum', bangla: 'পাঠ্যক্রম', category: 'Academic & Education' },
  { word: 'bibliography', bangla: 'গ্রন্থপঞ্জি', category: 'Academic & Education' },
  { word: 'plagiarism', bangla: 'সাহিত্যিক চুরি বা কুম্ভীলকবৃত্তি', category: 'Academic & Education' },
  { word: 'postgraduate', bangla: 'স্নাতকোত্তর শিক্ষার্থী', category: 'Academic & Education' },
  { word: 'undergraduate', bangla: 'স্নাতক পর্যায়ের শিক্ষার্থী', category: 'Academic & Education' },
  { word: 'vocational course', bangla: 'বৃত্তিমূলক কোর্স', category: 'Academic & Education' },
  { word: 'compulsory subject', bangla: 'বাধ্যতামূলক বিষয়', category: 'Academic & Education' },
  { word: 'assessment criteria', bangla: 'মূল্যায়নের মানদণ্ড', category: 'Academic & Education' },
  { word: 'laboratory equipment', bangla: 'গবেষণাগারের সরঞ্জাম', category: 'Science & Research' },
  { word: 'fieldwork', bangla: 'মাঠ পর্যায়ের গবেষণা', category: 'Academic & Education' },
  { word: 'accommodation', bangla: 'বাসস্থান বা আবাসন', category: 'Travel & Living' },
  { word: 'youth hostel', bangla: 'যুব হোস্টেল', category: 'Travel & Living' },
  { word: 'self-catering', bangla: 'নিজের রান্না করে থাকার ব্যবস্থা', category: 'Travel & Living' },
  { word: 'bed and breakfast', bangla: 'থাকা ও সকালের নাস্তার ব্যবস্থা', category: 'Travel & Living' },
  { word: 'itinerary', bangla: 'ভ্রমণসূচি', category: 'Travel & Living' },
  { word: 'complimentary shuttle', bangla: 'বিনামূল্যে যাতায়াত বাস', category: 'Travel & Living' },
  { word: 'boarding pass', bangla: 'বিমানে ওঠার পাস', category: 'Travel & Living' },
  { word: 'customs declaration', bangla: 'শুল্ক ঘোষণা পত্র', category: 'Travel & Living' },
  { word: 'baggage allowance', bangla: 'মালপত্র বহনের অনুমোদিত ওজন', category: 'Travel & Living' },
  { word: 'souvenir', bangla: 'স্মৃতিচিহ্ন বা উপহার', category: 'Travel & Living' },
  { word: 'refreshments', bangla: 'হালকা খাবার ও পানীয়', category: 'Health & Nutrition' },
  { word: 'vegetarian option', bangla: 'নিরামিষ খাবার', category: 'Health & Nutrition' },
  { word: 'food allergy', bangla: 'খাবারে এলার্জি', category: 'Health & Nutrition' },
  { word: 'immune system', bangla: 'রোগ প্রতিরোধ ক্ষমতা', category: 'Health & Nutrition' },
  { word: 'cardiovascular', bangla: 'হৃদযন্ত্র ও রক্তনালী সম্পর্কিত', category: 'Health & Nutrition' },
  { word: 'physiotherapy', bangla: 'ফিজিওথেরাপি (শারীরিক চিকিৎসা)', category: 'Health & Nutrition' },
  { word: 'prescription', bangla: 'চিকিৎসকের ব্যবস্থাপত্র', category: 'Health & Nutrition' },
  { word: 'vaccination', bangla: 'টিকাদান', category: 'Health & Nutrition' },
  { word: 'antibiotics', bangla: 'অ্যান্টিবায়োটিক ওষুধ', category: 'Health & Nutrition' },
  { word: 'rehabilitation', bangla: 'পুনর্বাসন', category: 'Health & Nutrition' },
  { word: 'biodiversity', bangla: 'জীববৈচিত্র্য', category: 'Environment & Nature' },
  { word: 'deforestation', bangla: 'বন উজাড়করণ', category: 'Environment & Nature' },
  { word: 'renewable energy', bangla: 'নবায়নযোগ্য শক্তি', category: 'Environment & Nature' },
  { word: 'solar panels', bangla: 'সৌর প্যানেল', category: 'Environment & Nature' },
  { word: 'carbon footprint', bangla: 'কার্বন নিঃসরণের পরিমাণ', category: 'Environment & Nature' },
  { word: 'endangered species', bangla: 'বিপন্ন প্রজাতি', category: 'Environment & Nature' },
  { word: 'ecosystem', bangla: 'বাস্তুতন্ত্র', category: 'Environment & Nature' },
  { word: 'conservation', bangla: 'সংরক্ষণ', category: 'Environment & Nature' },
  { word: 'meteorology', bangla: 'আবহাওয়াবিজ্ঞান', category: 'Environment & Nature' },
  { word: 'precipitation', bangla: 'বৃষ্টিপাত বা তুষারপাত', category: 'Environment & Nature' },
  { word: 'erosion', bangla: 'ভূমি ক্ষয়', category: 'Environment & Nature' },
  { word: 'irrigation', bangla: 'সেচ ব্যবস্থা', category: 'Environment & Nature' },
  { word: 'amphitheatre', bangla: 'উন্মুক্ত গোলাকার নাট্যশালা', category: 'Architecture & Places' },
  { word: 'planetarium', bangla: 'তারামণ্ডল বা প্ল্যানেটারিয়াম', category: 'Architecture & Places' },
  { word: 'conservatory', bangla: 'কাঁচঘেরা উদ্ভিদ উদ্যান বা সংগীত বিদ্যাপীঠ', category: 'Architecture & Places' },
  { word: 'auditorium', bangla: 'মিলনায়তন', category: 'Architecture & Places' },
  { word: 'pavilion', bangla: 'মণ্ডপ বা প্যাভিলিয়ন', category: 'Architecture & Places' },
  { word: 'pedestrian crossing', bangla: 'পথচারী পারাপার', category: 'Architecture & Places' },
  { word: 'roundabout', bangla: 'গোলচত্বর', category: 'Architecture & Places' },
  { word: 'cul-de-sac', bangla: 'কানাগলি (একমুখী রাস্তা)', category: 'Architecture & Places' },
  { word: 'entrepreneurship', bangla: 'উদ্যোক্তা হওয়ার গুণাবলি', category: 'Workplace & Business' },
  { word: 'human resources', bangla: 'মানবসম্পদ বিভাগ', category: 'Workplace & Business' },
  { word: 'apprenticeship', bangla: 'শিক্ষানবিশ কাল', category: 'Workplace & Business' },
  { word: 'probationary period', bangla: 'শিক্ষানবিশ বা যাচাই কাল', category: 'Workplace & Business' },
  { word: 'remuneration', bangla: 'পারিশ্রমিক বা বেতন', category: 'Workplace & Business' },
  { word: 'colleague', bangla: 'সহকর্মী', category: 'Workplace & Business' },
  { word: 'questionnaire', bangla: 'প্রশ্নমালা', category: 'Academic & Education' },
  { word: 'bureaucracy', bangla: 'আমলাতন্ত্র', category: 'Workplace & Business' },
  { word: 'hierarchy', bangla: 'পদসোপান বা শ্রেণিবিন্যাস', category: 'Workplace & Business' },
  { word: 'subsidiary', bangla: 'সহযোগী প্রতিষ্ঠান', category: 'Workplace & Business' },
  { word: 'archaeology', bangla: 'প্রত্নতত্ত্ব', category: 'Science & Research' },
  { word: 'anthropology', bangla: 'নৃবিজ্ঞান', category: 'Science & Research' },
];

const EXTRA_MISSING_BASES: Array<{ word: string; bangla: string; category: string }> = [
  { word: 'reference number', bangla: 'রেফারেন্স নম্বর', category: 'Finance & Membership' },
  { word: 'membership card', bangla: 'সদস্যপদ কার্ড', category: 'Finance & Membership' },
  { word: 'security deposit', bangla: 'নিরাপত্তা জামানত', category: 'Finance & Membership' },
  { word: 'insurance premium', bangla: 'বীমা কিস্তি', category: 'Finance & Membership' },
  { word: 'installment plan', bangla: 'কিস্তি পরিকল্পনা', category: 'Finance & Membership' },
  { word: 'peak hours', bangla: 'ব্যস্ততম সময়', category: 'Days & Time' },
  { word: 'off-peak ticket', bangla: 'কম ভিড়ের সময়ের টিকিট', category: 'Travel & Living' },
  { word: 'commuter train', bangla: 'যাত্রীবাহী লোকাল ট্রেন', category: 'Travel & Living' },
  { word: 'platform ticket', bangla: 'প্ল্যাটফর্ম টিকিট', category: 'Travel & Living' },
  { word: 'return journey', bangla: 'ফিরতি যাত্রা', category: 'Travel & Living' },
  { word: 'guided tour', bangla: 'গাইডসহ ভ্রমণ', category: 'Travel & Living' },
  { word: 'audio guide', bangla: 'অডিও গাইড', category: 'Travel & Living' },
  { word: 'exhibition hall', bangla: 'প্রদর্শনী কক্ষ', category: 'Architecture & Places' },
  { word: 'botanical garden', bangla: 'উদ্ভিদ উদ্যান', category: 'Architecture & Places' },
  { word: 'information desk', bangla: 'তথ্য কেন্দ্র', category: 'Architecture & Places' },
  { word: 'cloakroom', bangla: 'মালপত্র বা কোট রাখার কক্ষ', category: 'Architecture & Places' },
  { word: 'emergency exit', bangla: 'জরুরি বহির্গমন পথ', category: 'Architecture & Places' },
  { word: 'fire extinguisher', bangla: 'অগ্নিনির্বাপক যন্ত্র', category: 'Architecture & Places' },
  { word: 'first aid kit', bangla: 'প্রাথমিক চিকিৎসার বাক্স', category: 'Health & Nutrition' },
  { word: 'protective gear', bangla: 'সুরক্ষামূলক পোশাক ও সরঞ্জাম', category: 'Sports & Outdoor' },
  { word: 'life jacket', bangla: 'লাইফ জ্যাকেট', category: 'Sports & Outdoor' },
  { word: 'diving instructor', bangla: 'ডাইভিং প্রশিক্ষক', category: 'Sports & Outdoor' },
  { word: 'climbing harness', bangla: 'পাহাড়ে চড়ার নিরাপত্তা বেল্ট', category: 'Sports & Outdoor' },
  { word: 'mountain biking', bangla: 'পাহাড়ে সাইকেল চালনা', category: 'Sports & Outdoor' },
  { word: 'horse riding', bangla: 'ঘোড়ায় চড়া', category: 'Sports & Outdoor' },
  { word: 'badminton court', bangla: 'ব্যাডমিন্টন কোর্ট', category: 'Sports & Outdoor' },
  { word: 'swimming pool', bangla: 'সুইমিং পুল', category: 'Sports & Outdoor' },
  { word: 'fitness suite', bangla: 'ব্যায়ামাগার কক্ষ', category: 'Sports & Outdoor' },
  { word: 'personal trainer', bangla: 'ব্যক্তিগত ফিটনেস প্রশিক্ষক', category: 'Sports & Outdoor' },
  { word: 'locker room', bangla: 'পোশাক পরিবর্তন ও লকার কক্ষ', category: 'Sports & Outdoor' },
  { word: 'lecture theatre', bangla: 'বড় লেকচার কক্ষ', category: 'Academic & Education' },
  { word: 'seminar room', bangla: 'সেমিনার কক্ষ', category: 'Academic & Education' },
  { word: 'tutorial group', bangla: 'টিউটোরিয়াল দল', category: 'Academic & Education' },
  { word: 'student union', bangla: 'ছাত্র সংসদ', category: 'Academic & Education' },
  { word: 'library fine', bangla: 'গ্রন্থাগারের জরিমানা', category: 'Academic & Education' },
  { word: 'interlibrary loan', bangla: 'আন্তঃগ্রন্থাগার বই ধার', category: 'Academic & Education' },
  { word: 'journal article', bangla: 'জার্নাল প্রবন্ধ', category: 'Academic & Education' },
  { word: 'case study', bangla: 'কেস স্টাডি বা ঘটনা সমীক্ষা', category: 'Academic & Education' },
  { word: 'statistical data', bangla: 'পরিসংখ্যানগত তথ্য', category: 'Science & Research' },
  { word: 'control group', bangla: 'নিয়ন্ত্রিত গবেষণাদল', category: 'Science & Research' },
  { word: 'hypothesis', bangla: 'অনুমান বা প্রকল্প', category: 'Science & Research' },
  { word: 'microorganism', bangla: 'অণুজীব', category: 'Science & Research' },
  { word: 'photosynthesis', bangla: 'সালোকসংশ্লেষণ', category: 'Science & Research' },
  { word: 'sedimentation', bangla: 'পলি জমাট বাঁধা', category: 'Science & Research' },
  { word: 'evaporation', bangla: 'বাষ্পীভবন', category: 'Science & Research' },
  { word: 'desalination', bangla: 'লবণমুক্তকরণ প্রক্রিয়া', category: 'Science & Research' },
  { word: 'telecommunications', bangla: 'টেলিযোগাযোগ', category: 'Science & Research' },
  { word: 'nanotechnology', bangla: 'ন্যানো প্রযুক্তি', category: 'Science & Research' },
  { word: 'artificial intelligence', bangla: 'কৃত্রিম বুদ্ধিমত্তা', category: 'Science & Research' },
  { word: 'genetic modification', bangla: 'জিনগত পরিবর্তন', category: 'Science & Research' },
  { word: 'fossil fuels', bangla: 'জীবাশ্ম জ্বালানি', category: 'Environment & Nature' },
  { word: 'greenhouse gases', bangla: 'গ্রিনহাউস গ্যাস', category: 'Environment & Nature' },
  { word: 'waste management', bangla: 'বর্জ্য ব্যবস্থাপনা', category: 'Environment & Nature' },
  { word: 'water purification', bangla: 'পানি বিশুদ্ধকরণ', category: 'Environment & Nature' },
  { word: 'wildlife sanctuary', bangla: 'বন্যপ্রাণী অভয়ারণ্য', category: 'Environment & Nature' },
  { word: 'coastal erosion', bangla: 'উপকূলীয় ভাঙন', category: 'Environment & Nature' },
  { word: 'maternity leave', bangla: 'মাতৃত্বকালীন ছুটি', category: 'Workplace & Business' },
  { word: 'curriculum vitae', bangla: 'জীবনবৃত্তান্ত (সিভি)', category: 'Workplace & Business' },
  { word: 'letter of recommendation', bangla: 'সুপারিশপত্র', category: 'Academic & Education' },
  { word: 'board of directors', bangla: 'পরিচালনা পর্ষদ', category: 'Workplace & Business' },
  { word: 'quality assurance', bangla: 'মান নিশ্চিতকরণ', category: 'Workplace & Business' },
  { word: 'customer satisfaction', bangla: 'গ্রাহক সন্তুষ্টি', category: 'Workplace & Business' },
  { word: 'safety regulations', bangla: 'নিরাপত্তা বিধিমালা', category: 'Workplace & Business' },
  { word: 'parking permit', bangla: 'পার্কিং অনুমতিপত্র', category: 'Travel & Living' },
];

const CORE_BUNDLED_WORDS: Array<{ word: string; bangla: string; category: string }> = [
  { word: 'archery', bangla: 'তীরন্দাজি', category: 'Sports & Outdoor' },
  { word: 'trekking', bangla: 'দুর্গম পথে হাঁটা বা ট্রেকিং', category: 'Sports & Outdoor' },
  { word: 'athletics', bangla: 'অ্যাথলেটিক্স বা শরীরচর্চা খেলাধুলা', category: 'Sports & Outdoor' },
  { word: 'Monday', bangla: 'সোমবার', category: 'Days & Time' },
  { word: 'Tuesday', bangla: 'মঙ্গলবার', category: 'Days & Time' },
  { word: 'Wednesday', bangla: 'বুধবার', category: 'Days & Time' },
  { word: 'Thursday', bangla: 'বৃহস্পতিবার', category: 'Days & Time' },
  { word: 'Friday', bangla: 'শুক্রবার', category: 'Days & Time' },
  { word: 'Saturday', bangla: 'শনিবার', category: 'Days & Time' },
  { word: 'Sunday', bangla: 'রবিবার', category: 'Days & Time' },
  { word: 'January', bangla: 'জানুয়ারি', category: 'Days & Time' },
  { word: 'February', bangla: 'ফেব্রুয়ারি', category: 'Days & Time' },
  { word: 'August', bangla: 'আগস্ট', category: 'Days & Time' },
  { word: 'September', bangla: 'সেপ্টেম্বর', category: 'Days & Time' },
  { word: 'October', bangla: 'অক্টোবর', category: 'Days & Time' },
  { word: 'November', bangla: 'নভেম্বর', category: 'Days & Time' },
  { word: 'December', bangla: 'ডিসেম্বর', category: 'Days & Time' },
  { word: 'weekend', bangla: 'সাপ্তাহিক ছুটি', category: 'Days & Time' },
  { word: 'semester', bangla: 'সেমিস্টার বা শিক্ষাবর্ষের অর্ধাংশ', category: 'Academic & Education' },
  { word: 'scholarship', bangla: 'শিক্ষাবৃত্তি', category: 'Academic & Education' },
  { word: 'professor', bangla: 'অধ্যাপক', category: 'Academic & Education' },
  { word: 'coordinator', bangla: 'সমন্বয়কারী', category: 'Academic & Education' },
  { word: 'certificate', bangla: 'সনদপত্র', category: 'Academic & Education' },
  { word: 'diploma', bangla: 'ডিপ্লোমা ডিগ্রি', category: 'Academic & Education' },
  { word: 'attendance', bangla: 'উপস্থিতি', category: 'Academic & Education' },
  { word: 'assignment', bangla: 'নির্ধারিত কাজ বা অ্যাসাইনমেন্ট', category: 'Academic & Education' },
  { word: 'examination', bangla: 'পরীক্ষা', category: 'Academic & Education' },
  { word: 'graduation', bangla: 'স্নাতক সমাপনী', category: 'Academic & Education' },
  { word: 'dormitory', bangla: 'ছাত্রাবাস', category: 'Travel & Living' },
  { word: 'apartment', bangla: 'অ্যাপার্টমেন্ট বা ফ্ল্যাট', category: 'Travel & Living' },
  { word: 'landlord', bangla: 'বাড়িওয়ালা', category: 'Travel & Living' },
  { word: 'tenant', bangla: 'ভাড়াটে', category: 'Travel & Living' },
  { word: 'utilities', bangla: 'গ্যাস-বিদ্যুৎ-পানি পরিষেবা', category: 'Travel & Living' },
  { word: 'furnishings', bangla: 'আসবাবপত্র', category: 'Travel & Living' },
  { word: 'refrigerator', bangla: 'রেফ্রিজারেটর বা ফ্রিজ', category: 'Travel & Living' },
  { word: 'microwave', bangla: 'মাইক্রোওয়েভ ওভেন', category: 'Travel & Living' },
  { word: 'vacuum cleaner', bangla: 'ভ্যাকুয়াম ক্লিনার', category: 'Travel & Living' },
  { word: 'air conditioning', bangla: 'শীতাতপ নিয়ন্ত্রণ ব্যবস্থা', category: 'Travel & Living' },
  { word: 'balcony', bangla: 'বারান্দা', category: 'Architecture & Places' },
  { word: 'corridor', bangla: 'বারান্দা বা করিডোর', category: 'Architecture & Places' },
  { word: 'basement', bangla: 'ভবনের ভূগর্ভস্থ তলা', category: 'Architecture & Places' },
  { word: 'reception', bangla: 'অভ্যর্থনা কক্ষ', category: 'Architecture & Places' },
  { word: 'cafeteria', bangla: 'ক্যাফেটেরিয়া বা ভোজনালয়', category: 'Architecture & Places' },
  { word: 'restaurant', bangla: 'রেস্তোরাঁ', category: 'Architecture & Places' },
  { word: 'supermarket', bangla: 'সুপারমার্কেট', category: 'Architecture & Places' },
  { word: 'pharmacy', bangla: 'ওষুধের দোকান বা ফার্মেসি', category: 'Health & Nutrition' },
  { word: 'nutrition', bangla: 'পুষ্টি', category: 'Health & Nutrition' },
  { word: 'proteins', bangla: 'প্রোটিন বা আমিষ', category: 'Health & Nutrition' },
  { word: 'carbohydrates', bangla: 'শর্করা', category: 'Health & Nutrition' },
  { word: 'vitamins', bangla: 'ভিটামিন বা খাদ্যপ্রাণ', category: 'Health & Nutrition' },
  { word: 'minerals', bangla: 'খনিজ উপাদান', category: 'Health & Nutrition' },
  { word: 'cholesterol', bangla: 'কোলেস্টেরল', category: 'Health & Nutrition' },
  { word: 'diabetes', bangla: 'ডায়াবেটিস বা বহুমূত্র রোগ', category: 'Health & Nutrition' },
  { word: 'obesity', bangla: 'স্থূলতা বা অতিরিক্ত ওজন', category: 'Health & Nutrition' },
  { word: 'metabolism', bangla: 'বিপাক প্রক্রিয়া', category: 'Health & Nutrition' },
  { word: 'symptom', bangla: 'রোগের লক্ষণ', category: 'Health & Nutrition' },
  { word: 'diagnosis', bangla: 'রোগ নির্ণয়', category: 'Health & Nutrition' },
  { word: 'surgeon', bangla: 'শল্যচিকিৎসক বা সার্জন', category: 'Health & Nutrition' },
  { word: 'ambulance', bangla: 'অ্যাম্বুলেন্স', category: 'Health & Nutrition' },
  { word: 'emergency', bangla: 'জরুরি অবস্থা', category: 'Health & Nutrition' },
  { word: 'tournament', bangla: 'টুর্নামেন্ট বা ক্রীড়া প্রতিযোগিতা', category: 'Sports & Outdoor' },
  { word: 'championship', bangla: 'চ্যাম্পিয়নশিপ', category: 'Sports & Outdoor' },
  { word: 'gymnasium', bangla: 'ব্যায়ামাগার', category: 'Sports & Outdoor' },
  { word: 'stadium', bangla: 'স্টেডিয়াম', category: 'Sports & Outdoor' },
  { word: 'spectator', bangla: 'দর্শক', category: 'Sports & Outdoor' },
  { word: 'marathon', bangla: 'ম্যারাথন দৌড়', category: 'Sports & Outdoor' },
  { word: 'cycling', bangla: 'সাইকেল চালনা', category: 'Sports & Outdoor' },
  { word: 'rowing', bangla: 'বৈঠা বেয়ে নৌকা চালানো', category: 'Sports & Outdoor' },
  { word: 'fencing', bangla: 'তলোয়ার খেলা (ফেন্সিং)', category: 'Sports & Outdoor' },
  { word: 'gymnastics', bangla: 'জিমন্যাস্টিকস', category: 'Sports & Outdoor' },
  { word: 'atmosphere', bangla: 'বায়ুমণ্ডল', category: 'Environment & Nature' },
  { word: 'temperature', bangla: 'তাপমাত্রা', category: 'Environment & Nature' },
  { word: 'hurricane', bangla: 'ঘূর্ণিঝড় বা হারিকেন', category: 'Environment & Nature' },
  { word: 'earthquake', bangla: 'ভূমিকম্প', category: 'Environment & Nature' },
  { word: 'volcano', bangla: 'আগ্নেয়গিরি', category: 'Environment & Nature' },
  { word: 'peninsula', bangla: 'উপদ্বীপ', category: 'Environment & Nature' },
  { word: 'archipelago', bangla: 'দ্বীপপুঞ্জ', category: 'Environment & Nature' },
  { word: 'glacier', bangla: 'হিমবাহ', category: 'Environment & Nature' },
  { word: 'drought', bangla: 'খরা', category: 'Environment & Nature' },
  { word: 'agriculture', bangla: 'কৃষিকাজ', category: 'Environment & Nature' },
  { word: 'fertilizer', bangla: 'সার', category: 'Environment & Nature' },
  { word: 'pesticide', bangla: 'কীটনাশক', category: 'Environment & Nature' },
  { word: 'recycling', bangla: 'পুনর্ব্যবহারযোগ্য করা', category: 'Environment & Nature' },
  { word: 'pollution', bangla: 'দূষণ', category: 'Environment & Nature' },
  { word: 'sustainability', bangla: 'টেকসই উন্নয়ন সক্ষমতা', category: 'Environment & Nature' },
  { word: 'corporation', bangla: 'কর্পোরেশন বা বৃহৎ কোম্পানি', category: 'Workplace & Business' },
  { word: 'management', bangla: 'ব্যবস্থাপনা', category: 'Workplace & Business' },
  { word: 'executive', bangla: 'কার্যনির্বাহী কর্মকর্তা', category: 'Workplace & Business' },
  { word: 'accountant', bangla: 'হিসাবরক্ষক', category: 'Workplace & Business' },
  { word: 'marketing', bangla: 'বিপণন', category: 'Workplace & Business' },
  { word: 'advertisement', bangla: 'বিজ্ঞাপন', category: 'Workplace & Business' },
  { word: 'negotiation', bangla: 'আলোচনা বা দরকষাকষি', category: 'Workplace & Business' },
  { word: 'productivity', bangla: 'উৎপাদনশীলতা', category: 'Workplace & Business' },
  { word: 'manufacture', bangla: 'উৎপাদন বা নির্মাণ', category: 'Workplace & Business' },
  { word: 'distribution', bangla: 'বিতরণ', category: 'Workplace & Business' },
  { word: 'receipt', bangla: 'রসিদ', category: 'Finance & Membership' },
  { word: 'invoice', bangla: 'চালান বা বিল', category: 'Finance & Membership' },
  { word: 'mortgage', bangla: 'বন্ধকী ঋণ', category: 'Finance & Membership' },
  { word: 'currency', bangla: 'মুদ্রা', category: 'Finance & Membership' },
  { word: 'budget', bangla: 'বাজেট বা আয়-ব্যয়ের হিসাব', category: 'Finance & Membership' },
];

const BUNDLED_STEMS: Array<{ stem: string; bangla: string; category: string }> = [
  { stem: 'enrollment', bangla: 'ভর্তি বা তালিকাভুক্তি', category: 'Academic & Education' },
  { stem: 'orientation', bangla: 'পরিচিতি পর্ব', category: 'Academic & Education' },
  { stem: 'counseling', bangla: 'পরামর্শ সেবা', category: 'Academic & Education' },
  { stem: 'supervisor', bangla: 'তত্ত্বাবধায়ক', category: 'Academic & Education' },
  { stem: 'prospectus', bangla: 'বিবরণী পুস্তিকা', category: 'Academic & Education' },
  { stem: 'handout', bangla: 'লেকচার নোট বা হ্যান্ডআউট', category: 'Academic & Education' },
  { stem: 'module', bangla: 'পাঠ্য মডিউল', category: 'Academic & Education' },
  { stem: 'faculty', bangla: 'অনুষদ', category: 'Academic & Education' },
  { stem: 'campus', bangla: 'বিশ্ববিদ্যালয় প্রাঙ্গণ', category: 'Academic & Education' },
  { stem: 'library', bangla: 'গ্রন্থাগার', category: 'Academic & Education' },
  { stem: 'catalogue', bangla: 'তালিকা বা ক্যাটালগ', category: 'Academic & Education' },
  { stem: 'periodical', bangla: 'সাময়িকী', category: 'Academic & Education' },
  { stem: 'encyclopedia', bangla: 'বিশ্বকোষ', category: 'Academic & Education' },
  { stem: 'manuscript', bangla: 'পাণ্ডুলিপি', category: 'Academic & Education' },
  { stem: 'abstract', bangla: 'সারসংক্ষেপ', category: 'Academic & Education' },
  { stem: 'methodology', bangla: 'গবেষণা পদ্ধতি', category: 'Science & Research' },
  { stem: 'experiment', bangla: 'পরীক্ষণ', category: 'Science & Research' },
  { stem: 'microscope', bangla: 'অণুবীক্ষণ যন্ত্র', category: 'Science & Research' },
  { stem: 'telescope', bangla: 'দূরবীক্ষণ যন্ত্র', category: 'Science & Research' },
  { stem: 'astronomy', bangla: 'জ্যোতির্বিজ্ঞান', category: 'Science & Research' },
  { stem: 'geology', bangla: 'ভূতত্ত্ব', category: 'Science & Research' },
  { stem: 'chemistry', bangla: 'রসায়ন', category: 'Science & Research' },
  { stem: 'biology', bangla: 'জীববিজ্ঞান', category: 'Science & Research' },
  { stem: 'genetics', bangla: 'বংশগতিবিদ্যা', category: 'Science & Research' },
  { stem: 'evolution', bangla: 'বিবর্তন', category: 'Science & Research' },
  { stem: 'reservation', bangla: 'আসন বা কক্ষ সংরক্ষণ', category: 'Travel & Living' },
  { stem: 'departure', bangla: 'প্রস্থান', category: 'Travel & Living' },
  { stem: 'arrival', bangla: 'আগমন', category: 'Travel & Living' },
  { stem: 'terminal', bangla: 'টার্মিনাল', category: 'Travel & Living' },
  { stem: 'luggage', bangla: 'মালপত্র', category: 'Travel & Living' },
  { stem: 'passport', bangla: 'পাসপোর্ট', category: 'Travel & Living' },
  { stem: 'embassy', bangla: 'দূতাবাস', category: 'Travel & Living' },
  { stem: 'excursion', bangla: 'সংক্ষিপ্ত আনন্দভ্রমণ', category: 'Travel & Living' },
  { stem: 'destination', bangla: 'গন্তব্য', category: 'Travel & Living' },
  { stem: 'transportation', bangla: 'পরিবহন ব্যবস্থা', category: 'Travel & Living' },
];

const BUNDLED_MODIFIERS: Array<{ prefix: string; banglaPrefix: string }> = [
  { prefix: '', banglaPrefix: '' },
  { prefix: 'annual ', banglaPrefix: 'বার্ষিক ' },
  { prefix: 'preliminary ', banglaPrefix: 'প্রাথমিক ' },
  { prefix: 'advanced ', banglaPrefix: 'উন্নত ' },
  { prefix: 'international ', banglaPrefix: 'আন্তর্জাতিক ' },
  { prefix: 'regional ', banglaPrefix: 'আঞ্চলিক ' },
  { prefix: 'mandatory ', banglaPrefix: 'বাধ্যতামূলক ' },
  { prefix: 'optional ', banglaPrefix: 'ঐচ্ছিক ' },
  { prefix: 'certified ', banglaPrefix: 'সনদপ্রাপ্ত ' },
  { prefix: 'standard ', banglaPrefix: 'মানসম্মত ' },
  { prefix: 'digital ', banglaPrefix: 'ডিজিটাল ' },
  { prefix: 'academic ', banglaPrefix: 'একাডেমিক ' },
  { prefix: 'clinical ', banglaPrefix: 'ক্লিনিক্যাল ' },
  { prefix: 'environmental ', banglaPrefix: 'পরিবেশগত ' },
  { prefix: 'commercial ', banglaPrefix: 'বাণিজ্যিক ' },
  { prefix: 'residential ', banglaPrefix: 'আবাসিক ' },
  { prefix: 'municipal ', banglaPrefix: 'পৌর ' },
  { prefix: 'institutional ', banglaPrefix: 'প্রাতিষ্ঠানিক ' },
  { prefix: 'departmental ', banglaPrefix: 'বিভাগীয় ' },
  { prefix: 'supplementary ', banglaPrefix: 'সম্পূরক ' },
];

function buildCatalog(): WordItem[] {
  const items: WordItem[] = [];
  const seenIds = new Set<string>();
  const upload14Ids = new Set(SCREENSHOT_14_UPLOADS.map((u) => toWordId(u.word)));

  // 1. Add exact 139 Missing words first (starting with weekdays, annual fee, monthly membership, tuition fees)
  const allMissingCandidates = [...PRIORITY_MISSING_WORDS, ...EXTRA_MISSING_BASES];
  let missingCount = 0;

  for (const entry of allMissingCandidates) {
    if (missingCount >= 139) break;
    const id = toWordId(entry.word);
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    items.push({
      id,
      word: entry.word,
      bangla: entry.bangla,
      category: entry.category,
      hasBundledAudio: false,
      isFromUserScreenshotUploadBatch: upload14Ids.has(id),
    });
    missingCount++;
  }

  // 2. Add exact 782 Bundled words so total = 921 (782 Bundled + 139 Missing)
  let bundledCount = 0;
  for (const entry of CORE_BUNDLED_WORDS) {
    if (bundledCount >= 782) break;
    const id = toWordId(entry.word);
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    items.push({
      id,
      word: entry.word,
      bangla: entry.bangla,
      category: entry.category,
      hasBundledAudio: true,
      isFromUserScreenshotUploadBatch: upload14Ids.has(id),
    });
    bundledCount++;
  }

  for (const mod of BUNDLED_MODIFIERS) {
    if (bundledCount >= 782) break;
    for (const stemObj of BUNDLED_STEMS) {
      if (bundledCount >= 782) break;
      const word = `${mod.prefix}${stemObj.stem}`.trim();
      const id = toWordId(word);
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      items.push({
        id,
        word,
        bangla: `${mod.banglaPrefix}${stemObj.bangla}`.trim(),
        category: stemObj.category,
        hasBundledAudio: true,
        isFromUserScreenshotUploadBatch: upload14Ids.has(id),
      });
      bundledCount++;
    }
  }

  return items;
}

export const WORDS_CATALOG: WordItem[] = buildCatalog();

export const CATEGORIES = [
  'All Categories',
  'Days & Time',
  'Finance & Membership',
  'Sports & Outdoor',
  'Academic & Education',
  'Travel & Living',
  'Health & Nutrition',
  'Environment & Nature',
  'Architecture & Places',
  'Workplace & Business',
  'Science & Research',
];
