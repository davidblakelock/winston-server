import Anthropic from "@anthropic-ai/sdk";
import { query } from "../db.js";
import { logger } from "../lib/logger.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StoicEntry {
  dayNumber: number;
  quote: string;
  author: string;
  source: string;
  theme: string;
  phase: number;
  introContext?: string;
}

export interface UserSettings {
  stoicDay: number;
}

export const PHASE_NAMES: Record<number, string> = {
  1: "Foundation — What Is In Your Control",
  2: "Perception — How You See Determines What You Feel",
  3: "Action — The Discipline of Doing",
  4: "Will — Amor Fati, Loving What Is",
  5: "Virtue — The Life Worth Living",
  6: "The View From Above",
};

// ── 365-Day Stoic Curriculum ──────────────────────────────────────────────────
// Days 1–7 are gentle introduction days.
// Phase 1 (1–60):   Foundation — What Is In Your Control
// Phase 2 (61–120): Perception — How You See Determines What You Feel
// Phase 3 (121–200):Action — The Discipline of Doing
// Phase 4 (201–270):Will — Amor Fati, Loving What Is
// Phase 5 (271–330):Virtue — The Life Worth Living
// Phase 6 (331–365):The View From Above

export const STOIC_CURRICULUM: StoicEntry[] = [
  // ── INTRO DAYS 1–7 ───────────────────────────────────────────────────────
  { dayNumber: 1, quote: "When you wake up in the morning, tell yourself: the people I deal with today will be meddling, ungrateful, arrogant, dishonest, jealous and surly. They are like this because they cannot tell good from evil. But I have seen the beauty of good, and the ugliness of evil, and have recognized that the wrongdoer has a nature related to my own.", author: "Marcus Aurelius", source: "Meditations, 2.1", theme: "Morning Preparation", phase: 1, introContext: "Marcus Aurelius (121–180 AD) was a Roman Emperor and one of history's most unlikely philosophers. In the midst of war, plague, and empire, he kept a private journal — never meant for publication — called the Meditations. It is, at its heart, a man talking to himself: holding himself to a standard he found genuinely difficult. That journal is where today's thought comes from." },
  { dayNumber: 2, quote: "Some things are in our control and others not. Things in our control are opinion, pursuit, desire, aversion, and, in a word, whatever are our own actions. Things not in our control are body, reputation, command, and, in one word, whatever are not our own actions.", author: "Epictetus", source: "Enchiridion, 1", theme: "The Dichotomy of Control", phase: 1, introContext: "Epictetus (c. 50–135 AD) was born a slave in the Roman Empire. His master once broke his leg as a demonstration of power. Epictetus reportedly said, calmly, 'I told you it would break.' He was eventually freed, became a teacher, and his lectures — transcribed by a student — became the Discourses and the Enchiridion. His core insight: the body can be enslaved. The mind cannot." },
  { dayNumber: 3, quote: "Do this, my Lucilius: claim for yourself what has hitherto been taken from you — or rather, stolen from you. Set aside a certain number of hours each day for your mind. Let nothing interfere with this time. Time is the one thing that is truly ours.", author: "Seneca", source: "Letters to Lucilius, 1.1", theme: "On Time", phase: 1, introContext: "Lucius Annaeus Seneca (c. 4 BC–65 AD) was a playwright, philosopher, and advisor to Emperor Nero — a position that eventually got him killed. His letters to his friend Lucilius are among the most intimate documents of ancient philosophy: real correspondence, real doubt, real effort to live better. They read like emails between two thoughtful people trying to figure things out." },
  { dayNumber: 4, quote: "Think of yourself as a dead man. You have lived your life. Now take what's left and live it properly.", author: "Marcus Aurelius", source: "Meditations, 7.56", theme: "The View From Death", phase: 1, introContext: "The Stoics returned again and again to the practice of memento mori — remembering death — not from morbidity but from clarity. Marcus Aurelius, who ruled the most powerful empire on earth, used the thought of death the way a sculptor uses a chisel: to cut away what didn't matter and reveal what did." },
  { dayNumber: 5, quote: "Men are disturbed not by the things which happen, but by the opinions about the things. Death, for example, is nothing terrible — else it would have seemed so to Socrates. The terror consists in our notion of death, that it is terrible.", author: "Epictetus", source: "Enchiridion, 5", theme: "Opinion Creates Suffering", phase: 1, introContext: "Epictetus taught that almost all human suffering is self-inflicted — not by events, but by the story we tell about events. This one idea, if genuinely practiced, changes everything. He calls it the discipline of assent: choosing what to believe about what happens to you." },
  { dayNumber: 6, quote: "Retire into yourself as much as possible. Associate with those who are likely to make you better, and admit those whom you yourself can make better. These two things occur together, for men learn while they teach.", author: "Seneca", source: "Letters to Lucilius, 7.8", theme: "On Solitude and Company", phase: 1, introContext: "Seneca wrote his letters while navigating the most dangerous court in history. He didn't always live up to his own philosophy — he was wealthy, occasionally hypocritical, and knew it. But his honesty about the gap between ideal and reality is exactly what makes him so valuable. He was trying, in difficult circumstances, to be better. Like all of us." },
  { dayNumber: 7, quote: "The impediment to action advances action. What stands in the way becomes the way.", author: "Marcus Aurelius", source: "Meditations, 5.20", theme: "Obstacles as Opportunity", phase: 1, introContext: "This single line — one of the most compressed ideas in all of philosophy — became the foundation of Ryan Holiday's bestselling book The Obstacle Is the Way. Marcus wrote it as a reminder to himself during the catastrophic Antonine Plague, which killed five million people. He meant it personally. So should we." },

  // ── PHASE 1: FOUNDATION — Days 8–60 ──────────────────────────────────────
  { dayNumber: 8, quote: "Confine yourself to the present.", author: "Marcus Aurelius", source: "Meditations, 8.7", theme: "The Present Moment", phase: 1 },
  { dayNumber: 9, quote: "Make the best use of what is in your power, and take the rest as it happens.", author: "Epictetus", source: "Enchiridion, 1", theme: "Control and Acceptance", phase: 1 },
  { dayNumber: 10, quote: "All things, Lucilius, are not ours; time alone belongs to us. Nature has let us have possession of this one thing, this fleeting thing — and if a man will, he may snatch it away.", author: "Seneca", source: "Letters to Lucilius, 1.2", theme: "On Time", phase: 1 },
  { dayNumber: 11, quote: "If it is not right, do not do it; if it is not true, do not say it.", author: "Marcus Aurelius", source: "Meditations, 12.17", theme: "Integrity", phase: 1 },
  { dayNumber: 12, quote: "Seek not that the things which happen should happen as you wish; but wish the things which happen to be as they are, and you will have a tranquil flow of life.", author: "Epictetus", source: "Enchiridion, 8", theme: "Acceptance", phase: 1 },
  { dayNumber: 13, quote: "The greatest obstacle to living is expectancy, which hangs upon tomorrow and loses today.", author: "Seneca", source: "On the Shortness of Life, 9.1", theme: "Living Now", phase: 1 },
  { dayNumber: 14, quote: "Never esteem anything as of advantage to you that will make you break your word or lose your self-respect.", author: "Marcus Aurelius", source: "Meditations, 3.7", theme: "Self-Respect", phase: 1 },
  { dayNumber: 15, quote: "Wealth consists not in having great possessions, but in having few wants.", author: "Epictetus", source: "Discourses, 4.1", theme: "Simplicity", phase: 1 },
  { dayNumber: 16, quote: "It is not that things are difficult that we do not dare; it is because we do not dare that they are difficult.", author: "Seneca", source: "Letters to Lucilius, 104.26", theme: "Courage", phase: 1 },
  { dayNumber: 17, quote: "Accept the things to which fate binds you, and love the people with whom fate brings you together, and do so with all your heart.", author: "Marcus Aurelius", source: "Meditations, 6.39", theme: "Love and Fate", phase: 1 },
  { dayNumber: 18, quote: "First say to yourself what you would be; and then do what you have to do.", author: "Epictetus", source: "Discourses, 3.23", theme: "Identity and Action", phase: 1 },
  { dayNumber: 19, quote: "We suffer more in imagination than in reality.", author: "Seneca", source: "Letters to Lucilius, 13.4", theme: "Fear and Imagination", phase: 1 },
  { dayNumber: 20, quote: "Loss is nothing else but change, and change is Nature's delight.", author: "Marcus Aurelius", source: "Meditations, 9.35", theme: "Change", phase: 1 },
  { dayNumber: 21, quote: "No man is free who is not master of himself.", author: "Epictetus", source: "Fragments, 35", theme: "Self-Mastery", phase: 1 },
  { dayNumber: 22, quote: "A man who suffers before it is necessary suffers more than is necessary.", author: "Seneca", source: "Letters to Lucilius, 98.8", theme: "Premature Suffering", phase: 1 },
  { dayNumber: 23, quote: "Do every act of your life as though it were the very last act of your life.", author: "Marcus Aurelius", source: "Meditations, 2.14", theme: "Presence", phase: 1 },
  { dayNumber: 24, quote: "If you want to improve, be content to be thought foolish and stupid with regard to external things.", author: "Epictetus", source: "Enchiridion, 13", theme: "Growth Over Appearance", phase: 1 },
  { dayNumber: 25, quote: "While we delay, life rushes onward.", author: "Seneca", source: "Letters to Lucilius, 1.1", theme: "Urgency", phase: 1 },
  { dayNumber: 26, quote: "The best revenge is to be unlike him who performed the injury.", author: "Marcus Aurelius", source: "Meditations, 6.6", theme: "Responding to Wrongdoing", phase: 1 },
  { dayNumber: 27, quote: "Freedom is not procured by a full enjoyment of what is desired, but by controlling the desire.", author: "Epictetus", source: "Discourses, 4.1", theme: "Freedom", phase: 1 },
  { dayNumber: 28, quote: "Begin at once to live, and count each separate day as a separate life.", author: "Seneca", source: "Letters to Lucilius, 101.8", theme: "Living Fully", phase: 1 },
  { dayNumber: 29, quote: "Perfection of character is this: to live each day as if it were your last, without frenzy, without apathy, without pretense.", author: "Marcus Aurelius", source: "Meditations, 7.69", theme: "Character and Presence", phase: 1 },
  { dayNumber: 30, quote: "When you are offended at any man's fault, turn to yourself and study your own failings. Then you will forget your anger.", author: "Epictetus", source: "Enchiridion, 14", theme: "Self-Examination", phase: 1 },
  { dayNumber: 31, quote: "The object of life is not to be on the side of the majority, but to escape finding oneself in the ranks of the insane.", author: "Marcus Aurelius", source: "Meditations, 6.10", theme: "Integrity Over Conformity", phase: 1 },
  { dayNumber: 32, quote: "On the occasion of every accident that befalls you, remember to turn to yourself and inquire what power you have for turning it to use.", author: "Epictetus", source: "Enchiridion, 10", theme: "Using Every Event", phase: 1 },
  { dayNumber: 33, quote: "It is not the man who has too little who is poor, but the man who hankers after more.", author: "Seneca", source: "Letters to Lucilius, 2.6", theme: "Contentment", phase: 1 },
  { dayNumber: 34, quote: "Our life is what our thoughts make it.", author: "Marcus Aurelius", source: "Meditations, 4.3", theme: "The Power of Thought", phase: 1 },
  { dayNumber: 35, quote: "Make progress from moment to moment. Do not look for progress daily; look for it in yourself, from moment to moment.", author: "Epictetus", source: "Discourses, 1.4", theme: "Gradual Progress", phase: 1 },
  { dayNumber: 36, quote: "He who is everywhere is nowhere.", author: "Seneca", source: "Letters to Lucilius, 2.2", theme: "Focus", phase: 1 },
  { dayNumber: 37, quote: "You could leave life right now. Let that determine what you do and say and think.", author: "Marcus Aurelius", source: "Meditations, 4.17", theme: "Mortality as Teacher", phase: 1 },
  { dayNumber: 38, quote: "Never tell people you are a philosopher. Speak little of philosophical matters to the uninstructed. Instead, do what follows from being one.", author: "Epictetus", source: "Enchiridion, 46", theme: "Showing Not Telling", phase: 1 },
  { dayNumber: 39, quote: "If you are distressed by anything external, the pain is not due to the thing itself, but to your estimate of it; and this you have the power to revoke at any moment.", author: "Marcus Aurelius", source: "Meditations, 8.47", theme: "Judgment and Pain", phase: 1 },
  { dayNumber: 40, quote: "Nothing, to my way of thinking, is a better proof of a well-ordered mind than a man's ability to stop just where he is and pass some time in his own company.", author: "Seneca", source: "Letters to Lucilius, 2.1", theme: "Inner Company", phase: 1 },
  { dayNumber: 41, quote: "Nothing happens to any man that he is not formed by nature to bear.", author: "Marcus Aurelius", source: "Meditations, 5.18", theme: "Inner Strength", phase: 1 },
  { dayNumber: 42, quote: "Whoever does not regard what he has as most riches, is unhappy, though he be master of the world.", author: "Epictetus", source: "Fragments, 28", theme: "Gratitude", phase: 1 },
  { dayNumber: 43, quote: "Enjoy present pleasures in such a way as not to injure future ones.", author: "Seneca", source: "Letters to Lucilius, 59.15", theme: "Moderation", phase: 1 },
  { dayNumber: 44, quote: "If someone is able to show me that what I think or do is not right, I will happily change, for I seek the truth, by which no one was ever truly harmed.", author: "Marcus Aurelius", source: "Meditations, 6.21", theme: "Openness to Truth", phase: 1 },
  { dayNumber: 45, quote: "The higher we are placed, the more humbly we should walk.", author: "Cicero", source: "De Officiis, 1.26", theme: "Humility", phase: 1 },
  { dayNumber: 46, quote: "That which is not good for the bee-hive cannot be good for the bee.", author: "Marcus Aurelius", source: "Meditations, 6.54", theme: "Community", phase: 1 },
  { dayNumber: 47, quote: "Ask yourself at every moment: is this necessary?", author: "Marcus Aurelius", source: "Meditations, 4.24", theme: "Discipline of Desire", phase: 1 },
  { dayNumber: 48, quote: "To be everywhere is to be nowhere.", author: "Seneca", source: "Letters to Lucilius, 2.1", theme: "Presence and Focus", phase: 1 },
  { dayNumber: 49, quote: "Waste no more time arguing about what a good man should be. Be one.", author: "Marcus Aurelius", source: "Meditations, 10.16", theme: "Action Over Theory", phase: 1 },
  { dayNumber: 50, quote: "The soul becomes dyed with the color of its thoughts.", author: "Marcus Aurelius", source: "Meditations, 5.16", theme: "The Quality of Attention", phase: 1 },
  { dayNumber: 51, quote: "Caretake this moment. Immerse yourself in its particulars. Respond to this person, this challenge, this deed. Quit the evasions.", author: "Epictetus", source: "Discourses, 2.5", theme: "Presence", phase: 1 },
  { dayNumber: 52, quote: "No person has the power to have everything they want, but it is in their power not to want what they don't have, and to cheerfully put to good use what they do have.", author: "Seneca", source: "Letters to Lucilius, 123.3", theme: "Contentment", phase: 1 },
  { dayNumber: 53, quote: "You have power over your mind, not outside events. Realize this, and you will find strength.", author: "Marcus Aurelius", source: "Meditations, 6.52", theme: "Inner Power", phase: 1 },
  { dayNumber: 54, quote: "Seek not good from without; seek it within yourselves, or you will never find it.", author: "Epictetus", source: "Discourses, 3.24", theme: "The Inner Life", phase: 1 },
  { dayNumber: 55, quote: "It is not because things are difficult that we do not dare; it is because we do not dare that things are difficult.", author: "Seneca", source: "Letters to Lucilius, 104.26", theme: "Courage", phase: 1 },
  { dayNumber: 56, quote: "He who laughs at himself never runs out of things to laugh at.", author: "Epictetus", source: "Fragments", theme: "Self-Awareness", phase: 1 },
  { dayNumber: 57, quote: "Everything is opinion, and opinion is in your power.", author: "Marcus Aurelius", source: "Meditations, 12.22", theme: "The Power of Judgment", phase: 1 },
  { dayNumber: 58, quote: "The key is to keep company only with people who uplift you, whose presence calls forth your best.", author: "Epictetus", source: "Discourses, 3.16", theme: "Choosing Company", phase: 1 },
  { dayNumber: 59, quote: "Lay hold of today's task, and you will depend less upon tomorrow's.", author: "Seneca", source: "Letters to Lucilius, 1.3", theme: "Action Now", phase: 1 },
  { dayNumber: 60, quote: "Look well into thyself; there is a source of strength which will always spring up if thou wilt always look.", author: "Marcus Aurelius", source: "Meditations, 7.59", theme: "Inner Strength", phase: 1 },

  // ── PHASE 2: PERCEPTION — Days 61–120 ────────────────────────────────────
  { dayNumber: 61, quote: "Choose not to be harmed — and you won't feel harmed. Don't feel harmed — and you haven't been.", author: "Marcus Aurelius", source: "Meditations, 4.7", theme: "The Power of Perception", phase: 2 },
  { dayNumber: 62, quote: "It is not the things themselves that disturb men, but their judgments about these things.", author: "Epictetus", source: "Enchiridion, 5", theme: "Judgment", phase: 2 },
  { dayNumber: 63, quote: "A gem cannot be polished without friction, nor a man perfected without trials.", author: "Seneca", source: "Letters to Lucilius, 100.5", theme: "Adversity as Refinement", phase: 2 },
  { dayNumber: 64, quote: "How much more grievous are the consequences of anger than the causes of it.", author: "Marcus Aurelius", source: "Meditations, 11.18", theme: "On Anger", phase: 2 },
  { dayNumber: 65, quote: "People are not disturbed by events themselves but by the views they take of them.", author: "Epictetus", source: "Enchiridion, 5", theme: "Opinion Creates Reality", phase: 2 },
  { dayNumber: 66, quote: "He is a great man who uses earthen vessels as if they were silver; but he is equally great who uses silver as if it were earthen.", author: "Seneca", source: "Letters to Lucilius, 5.6", theme: "Equanimity", phase: 2 },
  { dayNumber: 67, quote: "Objective judgment, now, at this very moment. Unselfish action, now, at this very moment. Willing acceptance — now, at this very moment — of all external events.", author: "Marcus Aurelius", source: "Meditations, 9.7", theme: "Three Disciplines", phase: 2 },
  { dayNumber: 68, quote: "Never suppose that I think it is better to keep silence than to say something worth saying.", author: "Epictetus", source: "Discourses, 1.2", theme: "Speaking Truthfully", phase: 2 },
  { dayNumber: 69, quote: "It is not the man who has little, but the man who craves more, who is poor.", author: "Seneca", source: "Letters to Lucilius, 2.6", theme: "Contentment", phase: 2 },
  { dayNumber: 70, quote: "Your mind will take the shape of what you frequently hold in thought, for the human spirit is colored by such immersions.", author: "Marcus Aurelius", source: "Meditations, 5.16", theme: "Mental Habits", phase: 2 },
  { dayNumber: 71, quote: "Things do not touch the soul, for they are external and remain without; but our perturbations come only from the opinion which is within.", author: "Marcus Aurelius", source: "Meditations, 4.3", theme: "The Inner Citadel", phase: 2 },
  { dayNumber: 72, quote: "Practise then from the start to say to every harsh impression: you are an impression, and not at all the thing you appear to be.", author: "Epictetus", source: "Enchiridion, 1", theme: "Examining Impressions", phase: 2 },
  { dayNumber: 73, quote: "The mind is its own place, and in itself can make a heaven of hell, a hell of heaven.", author: "Seneca", source: "Letters to Lucilius, 28.6", theme: "Inner Reality", phase: 2 },
  { dayNumber: 74, quote: "How long are you going to wait before you demand the best for yourself?", author: "Epictetus", source: "Discourses, 1.2", theme: "Self-Demand", phase: 2 },
  { dayNumber: 75, quote: "Don't let your imagination be crushed by life as a whole. Don't try to picture everything bad that could possibly happen. Stick with the situation at hand.", author: "Marcus Aurelius", source: "Meditations, 8.36", theme: "Living With Clarity", phase: 2 },
  { dayNumber: 76, quote: "Regard as nothing the opinion of the crowd, neither dreading it nor courting it.", author: "Seneca", source: "Letters to Lucilius, 7.3", theme: "Independence of Mind", phase: 2 },
  { dayNumber: 77, quote: "Never be in a rush; do everything quietly and in a calm spirit. Do not lose your inner peace for anything whatsoever, even if your whole world seems upset.", author: "Epictetus", source: "Discourses, 2.16", theme: "Inner Peace", phase: 2 },
  { dayNumber: 78, quote: "Thou seest how few be the things, the which if a man has at his command his life flows gently on and is divine.", author: "Marcus Aurelius", source: "Meditations, 2.5", theme: "Simplicity", phase: 2 },
  { dayNumber: 79, quote: "It is quality rather than quantity that matters.", author: "Seneca", source: "Letters to Lucilius, 45.1", theme: "Quality Over Quantity", phase: 2 },
  { dayNumber: 80, quote: "The first and greatest victory is to conquer yourself; to be conquered by yourself is of all things most shameful and vile.", author: "Epictetus", source: "Fragments", theme: "Self-Mastery", phase: 2 },
  { dayNumber: 81, quote: "Never let the future disturb you. You will meet it, if you have to, with the same weapons of reason which today arm you against the present.", author: "Marcus Aurelius", source: "Meditations, 7.8", theme: "Trust in Reason", phase: 2 },
  { dayNumber: 82, quote: "We have two ears and one mouth so that we can listen twice as much as we speak.", author: "Epictetus", source: "Fragments, 1", theme: "Listening", phase: 2 },
  { dayNumber: 83, quote: "Avarice promises money; luxury, a varied assortment of pleasures; ambition, a purple robe and applause. Vices dangle their rewards before you — but you can choose to refuse.", author: "Seneca", source: "Letters to Lucilius, 51.5", theme: "Resisting Temptation", phase: 2 },
  { dayNumber: 84, quote: "Nowhere can man find a quieter or more untroubled retreat than in his own soul.", author: "Marcus Aurelius", source: "Meditations, 4.3", theme: "Inner Retreat", phase: 2 },
  { dayNumber: 85, quote: "If you wish to be good, first believe that you are bad.", author: "Epictetus", source: "Enchiridion, 5", theme: "Self-Knowledge", phase: 2 },
  { dayNumber: 86, quote: "There is nothing so wretched or foolish as to anticipate misfortune. What madness is it in your expecting evil before it arrives.", author: "Seneca", source: "Letters to Lucilius, 98.5", theme: "Anticipatory Fear", phase: 2 },
  { dayNumber: 87, quote: "How often have I found that what seemed a calamity was in fact a disguised opportunity. We do not see clearly until after the fact.", author: "Marcus Aurelius", source: "Meditations, 9.42", theme: "Reframing", phase: 2 },
  { dayNumber: 88, quote: "Don't explain your philosophy. Embody it.", author: "Epictetus", source: "Enchiridion, 46", theme: "Living It", phase: 2 },
  { dayNumber: 89, quote: "What need is there to weep over parts of life? The whole of it calls for tears.", author: "Seneca", source: "On Tranquility of Mind, 2.15", theme: "Perspective on Difficulty", phase: 2 },
  { dayNumber: 90, quote: "You always own the option of having no opinion. There is never any need to get worked up or to trouble your soul about things you can't control.", author: "Marcus Aurelius", source: "Meditations, 6.52", theme: "Choosing Opinions", phase: 2 },
  { dayNumber: 91, quote: "The man who has anticipated the coming of troubles takes away their power when they arrive.", author: "Seneca", source: "Letters to Lucilius, 98.7", theme: "Negative Visualization", phase: 2 },
  { dayNumber: 92, quote: "Man, what are you talking about? Me in chains? My leg you may fetter; but my will, not even Zeus himself can overpower.", author: "Epictetus", source: "Discourses, 1.1", theme: "The Will Cannot Be Enslaved", phase: 2 },
  { dayNumber: 93, quote: "Think of the life you have lived until now as over and, as a dead man, see what's left as a bonus and live it according to Nature.", author: "Marcus Aurelius", source: "Meditations, 7.56", theme: "Bonus Time", phase: 2 },
  { dayNumber: 94, quote: "No man was ever wise by chance.", author: "Seneca", source: "Letters to Lucilius, 76.6", theme: "Wisdom Requires Effort", phase: 2 },
  { dayNumber: 95, quote: "If a man knows not to which port he sails, no wind is favorable.", author: "Seneca", source: "Letters to Lucilius, 71.3", theme: "Purpose and Direction", phase: 2 },
  { dayNumber: 96, quote: "The happiness of your life depends upon the quality of your thoughts.", author: "Marcus Aurelius", source: "Meditations, 4.3", theme: "Quality of Thought", phase: 2 },
  { dayNumber: 97, quote: "Each day, acquire something that will fortify you against poverty, against death, indeed against other misfortunes as well.", author: "Seneca", source: "Letters to Lucilius, 98.3", theme: "Daily Fortification", phase: 2 },
  { dayNumber: 98, quote: "You become what you give your attention to.", author: "Epictetus", source: "Discourses, 2.18", theme: "Attention Shapes Character", phase: 2 },
  { dayNumber: 99, quote: "How much better to heal than seek revenge from injury.", author: "Seneca", source: "On Anger, 3.27", theme: "Healing Over Revenge", phase: 2 },
  { dayNumber: 100, quote: "The cucumber is bitter? Throw it away. There are brambles in the path? Walk around them. That is all you need to know.", author: "Marcus Aurelius", source: "Meditations, 8.7", theme: "Pragmatic Acceptance", phase: 2 },
  { dayNumber: 101, quote: "He who fears death will never do anything worthy of a man who is alive.", author: "Seneca", source: "Letters to Lucilius, 77.13", theme: "Freedom from Fear of Death", phase: 2 },
  { dayNumber: 102, quote: "Do not look around thee to discover other men's ruling principles, but look straight to this, to what nature leads thee, both the universal nature through the things that happen to thee, and thy own nature through the acts which must be done by thee.", author: "Marcus Aurelius", source: "Meditations, 5.3", theme: "Following Nature", phase: 2 },
  { dayNumber: 103, quote: "The greater the difficulty, the more glory in surmounting it. Skillful pilots gain their reputation from storms and tempests.", author: "Epictetus", source: "Discourses, 1.24", theme: "Difficulty as Glory", phase: 2 },
  { dayNumber: 104, quote: "Philosophy promises above all: common sense, humanity, and fellowship.", author: "Seneca", source: "Letters to Lucilius, 5.4", theme: "What Philosophy Offers", phase: 2 },
  { dayNumber: 105, quote: "To bear trials with a calm mind robs misfortune of its strength and burden.", author: "Seneca", source: "Hercules Furens, 462", theme: "Equanimity Under Trial", phase: 2 },
  { dayNumber: 106, quote: "When you are troubled by anything, you have forgotten this: that all things happen according to the universal nature.", author: "Marcus Aurelius", source: "Meditations, 12.26", theme: "The Larger Picture", phase: 2 },
  { dayNumber: 107, quote: "It never helps to know that there is no shelter from fortune. It helps to know you can endure it.", author: "Seneca", source: "Letters to Lucilius, 91.6", theme: "Resilience", phase: 2 },
  { dayNumber: 108, quote: "First keep the peace within yourself; then you can also bring peace to others.", author: "Epictetus", source: "Discourses, 4.8", theme: "Inner Peace First", phase: 2 },
  { dayNumber: 109, quote: "Receive without pride, relinquish without struggle.", author: "Marcus Aurelius", source: "Meditations, 8.33", theme: "Non-Attachment", phase: 2 },
  { dayNumber: 110, quote: "We are more often frightened than hurt; and we suffer more from imagination than from reality.", author: "Seneca", source: "Letters to Lucilius, 13.4", theme: "Imagination vs Reality", phase: 2 },
  { dayNumber: 111, quote: "To understand everything is to forgive everything.", author: "Epictetus", source: "Discourses, 1.18", theme: "Understanding and Forgiveness", phase: 2 },
  { dayNumber: 112, quote: "Anger, if not restrained, is frequently more hurtful to us than the injury that provokes it.", author: "Seneca", source: "On Anger, 3.25", theme: "The Cost of Anger", phase: 2 },
  { dayNumber: 113, quote: "Man is affected not by events but by the view he takes of them.", author: "Epictetus", source: "Enchiridion, 5", theme: "Interpretation", phase: 2 },
  { dayNumber: 114, quote: "Do not indulge in such thoughts: I shall live safely, and look down upon others; nor that I shall live in obscurity, and so be more secure.", author: "Marcus Aurelius", source: "Meditations, 6.2", theme: "Neither Prominence Nor Hiding", phase: 2 },
  { dayNumber: 115, quote: "Hold yourself to a higher standard than anyone else expects of you. Never excuse yourself.", author: "Epictetus", source: "Discourses, 3.12", theme: "High Standards", phase: 2 },
  { dayNumber: 116, quote: "He who is brave is free.", author: "Seneca", source: "Letters to Lucilius, 51.9", theme: "Courage and Freedom", phase: 2 },
  { dayNumber: 117, quote: "The things you think about determine the quality of your mind. Your soul takes on the color of your thoughts.", author: "Marcus Aurelius", source: "Meditations, 5.16", theme: "Quality of Mind", phase: 2 },
  { dayNumber: 118, quote: "Seek not the good in external things; seek it in yourself.", author: "Epictetus", source: "Discourses, 3.24", theme: "The Inner Good", phase: 2 },
  { dayNumber: 119, quote: "What difference does it make how much is laid away in a man's safe or in his barns, how large are his flocks and how fat his investments — he can bring nothing out of them into himself.", author: "Seneca", source: "Letters to Lucilius, 23.2", theme: "Inner Wealth", phase: 2 },
  { dayNumber: 120, quote: "If you are irritated by every rub, how will your mirror be polished?", author: "Epictetus", source: "Fragments", theme: "Irritation as Friction for Growth", phase: 2 },

  // ── PHASE 3: ACTION — Days 121–200 ───────────────────────────────────────
  { dayNumber: 121, quote: "The best way to avenge yourself is to not be like your enemy.", author: "Marcus Aurelius", source: "Meditations, 6.6", theme: "Character as Response", phase: 3 },
  { dayNumber: 122, quote: "You act as if you expect to live forever. But our life is woven of time and time is scarce. Do not waste it.", author: "Seneca", source: "On the Shortness of Life, 1.1", theme: "Time and Action", phase: 3 },
  { dayNumber: 123, quote: "If virtue promises happiness, prosperity, and peace, then progress in virtue is progress in each of these for to whatever point the perfection of anything brings us, progress is always an approach toward it.", author: "Epictetus", source: "Discourses, 1.4", theme: "Progress Toward Virtue", phase: 3 },
  { dayNumber: 124, quote: "Nothing is ours except time.", author: "Seneca", source: "Letters to Lucilius, 1.3", theme: "Time is All We Have", phase: 3 },
  { dayNumber: 125, quote: "Deem not life a thing of consequence. Face your death without flinching and never retreat. Make the most of what remains.", author: "Marcus Aurelius", source: "Meditations, 6.2", theme: "Living Without Fear", phase: 3 },
  { dayNumber: 126, quote: "Act your part with diligence and honor — that is sufficient.", author: "Epictetus", source: "Enchiridion, 17", theme: "Doing Your Part", phase: 3 },
  { dayNumber: 127, quote: "Retire into yourself as often as you can. Associate with those who will make you better.", author: "Seneca", source: "Letters to Lucilius, 7.8", theme: "Choosing Growth", phase: 3 },
  { dayNumber: 128, quote: "It is not enough to acquire wisdom; you must use it.", author: "Seneca", source: "Letters to Lucilius, 77.1", theme: "Wisdom in Action", phase: 3 },
  { dayNumber: 129, quote: "Every moment is an opportunity for virtue.", author: "Marcus Aurelius", source: "Meditations, 6.2", theme: "Every Moment Counts", phase: 3 },
  { dayNumber: 130, quote: "First learn, and then act accordingly. Thought without action is idle; action without thought is reckless.", author: "Epictetus", source: "Discourses, 2.5", theme: "Learning and Action", phase: 3 },
  { dayNumber: 131, quote: "Not for the purpose of display, but for use: for the employment of virtue.", author: "Seneca", source: "Letters to Lucilius, 20.2", theme: "Virtue for Use", phase: 3 },
  { dayNumber: 132, quote: "Refuse to inherit disgrace. Begin now. Make the best use of the time before you.", author: "Marcus Aurelius", source: "Meditations, 9.3", theme: "Starting Now", phase: 3 },
  { dayNumber: 133, quote: "Think not of what you lack but of what you have, then imagine how eagerly you would seek it, if it were not yours.", author: "Marcus Aurelius", source: "Meditations, 8.52 (Long trans.)", theme: "Gratitude and Perspective", phase: 3 },
  { dayNumber: 134, quote: "Show me that the good life doesn't consist of its length, but its use.", author: "Seneca", source: "Letters to Lucilius, 77.20", theme: "Depth Over Length", phase: 3 },
  { dayNumber: 135, quote: "God has entrusted me with myself. No man is free who is not master of himself.", author: "Epictetus", source: "Fragments, 35", theme: "Self-Ownership", phase: 3 },
  { dayNumber: 136, quote: "Confine yourself to present opportunities.", author: "Marcus Aurelius", source: "Meditations, 8.7", theme: "Present Opportunity", phase: 3 },
  { dayNumber: 137, quote: "Just keep in mind: the more we value things outside our control, the less control we have.", author: "Epictetus", source: "Discourses, 4.4", theme: "Control and Value", phase: 3 },
  { dayNumber: 138, quote: "No art is an island. Philosophy is the mother of all arts.", author: "Seneca", source: "Letters to Lucilius, 88.28", theme: "Integration of Wisdom", phase: 3 },
  { dayNumber: 139, quote: "Do what nature requires. Get moving, if you have it in you — and don't look around to see if others will know about it.", author: "Marcus Aurelius", source: "Meditations, 8.7", theme: "Acting Without Audience", phase: 3 },
  { dayNumber: 140, quote: "We must undergo a hard winter training and not rush into things for which we haven't prepared.", author: "Epictetus", source: "Discourses, 4.8", theme: "Preparation", phase: 3 },
  { dayNumber: 141, quote: "The rush and pressure of modern life are a form, perhaps the most common form, of its innate violence. To allow oneself to be carried away by a multitude of conflicting concerns... is to succumb to violence.", author: "Seneca", source: "On the Shortness of Life, 12.1", theme: "Simplicity Over Busyness", phase: 3 },
  { dayNumber: 142, quote: "Devote the remainder of your life to making progress. Waste not a single day.", author: "Marcus Aurelius", source: "Meditations, 3.14", theme: "Urgency of Growth", phase: 3 },
  { dayNumber: 143, quote: "Seek freedom and you will become a slave to it; seek discipline and you will find your freedom.", author: "Epictetus", source: "Discourses, 4.1", theme: "Discipline and Freedom", phase: 3 },
  { dayNumber: 144, quote: "Life is long, if you know how to use it.", author: "Seneca", source: "On the Shortness of Life, 1.1", theme: "The Long Life", phase: 3 },
  { dayNumber: 145, quote: "Never do anything that you wouldn't be comfortable doing if it could be seen by everyone.", author: "Marcus Aurelius", source: "Meditations, 3.16", theme: "Transparency of Character", phase: 3 },
  { dayNumber: 146, quote: "Seek not for events to happen as you wish, but wish events to happen as they do, and your life will go smoothly.", author: "Epictetus", source: "Enchiridion, 8", theme: "Alignment With Reality", phase: 3 },
  { dayNumber: 147, quote: "The mind must be exercised both day and night. For it feeds not the body but itself.", author: "Seneca", source: "Letters to Lucilius, 78.21", theme: "Exercise of Mind", phase: 3 },
  { dayNumber: 148, quote: "Let the work of thy hands and the purpose of thy mind be ordered toward community and the common good.", author: "Marcus Aurelius", source: "Meditations, 6.7", theme: "Service to Others", phase: 3 },
  { dayNumber: 149, quote: "First say what you would be; then do what you must do.", author: "Epictetus", source: "Discourses, 3.23", theme: "Clarity Before Action", phase: 3 },
  { dayNumber: 150, quote: "Think then, with thyself, how much better it is to be free from fever than to be cured of it. Even so, philosophy cures the fever of desire.", author: "Seneca", source: "Letters to Lucilius, 53.8", theme: "Philosophy as Medicine", phase: 3 },
  { dayNumber: 151, quote: "Begin the morning by saying to thyself: this day I shall meet with the busy-body, the ungrateful, the arrogant, the deceitful, the envious, the unsocial. All these things happen to them through ignorance of what is truly good and truly evil.", author: "Marcus Aurelius", source: "Meditations, 2.1", theme: "Preparing for Difficulty", phase: 3 },
  { dayNumber: 152, quote: "Keep your attention focused entirely on what is truly your own concern, and be clear that what belongs to others is their business and none of yours.", author: "Epictetus", source: "Enchiridion, 37", theme: "Minding Your Own Business", phase: 3 },
  { dayNumber: 153, quote: "Not to assume it's impossible because you find it hard. But to recognize that if it's humanly possible, you can do it too.", author: "Marcus Aurelius", source: "Meditations, 6.19", theme: "Possibility", phase: 3 },
  { dayNumber: 154, quote: "He who postpones the hour of living rightly is like the rustic who waits for the river to run out before he crosses.", author: "Horace", source: "Epistles, 1.2", theme: "Waiting vs Acting", phase: 3 },
  { dayNumber: 155, quote: "In the morning when you rise unwillingly, let this thought be present: I am rising to the work of a human being.", author: "Marcus Aurelius", source: "Meditations, 5.1", theme: "The Work of a Human Being", phase: 3 },
  { dayNumber: 156, quote: "Seek out an antagonist; he will make you strong. Struggle builds you. Comfort destroys you.", author: "Seneca", source: "Letters to Lucilius, 13.1", theme: "The Value of Challenge", phase: 3 },
  { dayNumber: 157, quote: "The first rule: keep an untroubled spirit. For all things must bow to it.", author: "Marcus Aurelius", source: "Meditations, 7.9", theme: "The Untroubled Spirit", phase: 3 },
  { dayNumber: 158, quote: "Practice yourself in little things and thence proceed to greater.", author: "Epictetus", source: "Discourses, 1.18", theme: "Start Small", phase: 3 },
  { dayNumber: 159, quote: "All the wisdom of the world is locked up in the act of restraining yourself, which is the act of self-mastery.", author: "Seneca", source: "On Anger, 3.36", theme: "Self-Restraint", phase: 3 },
  { dayNumber: 160, quote: "Get up from your bed and do the work you were meant to do.", author: "Marcus Aurelius", source: "Meditations, 5.1", theme: "Rising to Work", phase: 3 },
  { dayNumber: 161, quote: "Do not seek to have events happen as you want them to, but instead want them to happen as they do happen, and your life will go well.", author: "Epictetus", source: "Enchiridion, 8", theme: "Loving What Comes", phase: 3 },
  { dayNumber: 162, quote: "It is not what happens to you, but how you react to it that matters.", author: "Epictetus", source: "Discourses, 1.6", theme: "Response Over Event", phase: 3 },
  { dayNumber: 163, quote: "Do not think of what you have done already. Think of what you are going to do next, and begin.", author: "Marcus Aurelius", source: "Meditations, 8.7", theme: "Forward Focus", phase: 3 },
  { dayNumber: 164, quote: "Look beneath the surface. Let not the quality of a thing nor its worth escape thee.", author: "Marcus Aurelius", source: "Meditations, 6.3", theme: "Going Deeper", phase: 3 },
  { dayNumber: 165, quote: "That which is not good for the swarm is not good for the bee.", author: "Marcus Aurelius", source: "Meditations, 6.54", theme: "Collective Good", phase: 3 },
  { dayNumber: 166, quote: "We are like sailors who can trim the sails but cannot command the winds.", author: "Seneca", source: "Letters to Lucilius, 77.9", theme: "What We Control", phase: 3 },
  { dayNumber: 167, quote: "Demand the best from yourself right now, not at some future time.", author: "Epictetus", source: "Discourses, 1.2", theme: "Now, Not Later", phase: 3 },
  { dayNumber: 168, quote: "He who is everywhere is nowhere.", author: "Seneca", source: "Letters to Lucilius, 2.2", theme: "Focus", phase: 3 },
  { dayNumber: 169, quote: "Nothing in the world is worth turning your back on the truth.", author: "Marcus Aurelius", source: "Meditations, 6.21", theme: "Commitment to Truth", phase: 3 },
  { dayNumber: 170, quote: "Separate yourself from the mob. Nothing so undermines good character as sitting and listening to flatterers.", author: "Seneca", source: "Letters to Lucilius, 7.1", theme: "Choose Your Companions", phase: 3 },
  { dayNumber: 171, quote: "Understand at last that you have something in you more powerful and divine than what causes your bodily passions and makes you a mere puppet.", author: "Marcus Aurelius", source: "Meditations, 12.3", theme: "The Inner Divinity", phase: 3 },
  { dayNumber: 172, quote: "Every day I try to reduce the number of things I have to choose between.", author: "Epictetus", source: "Discourses, 4.4", theme: "Simplicity of Choice", phase: 3 },
  { dayNumber: 173, quote: "Let philosophy wipe your tears away. It is the greatest of arts.", author: "Seneca", source: "Letters to Lucilius, 63.1", theme: "Philosophy as Comfort", phase: 3 },
  { dayNumber: 174, quote: "The wise man does nothing reluctantly.", author: "Seneca", source: "Letters to Lucilius, 61.2", theme: "Willing Action", phase: 3 },
  { dayNumber: 175, quote: "Do not let what you cannot do interfere with what you can do.", author: "Epictetus", source: "Discourses, 2.5", theme: "Focus on the Possible", phase: 3 },
  { dayNumber: 176, quote: "Never stop sowing. Even in old age sow; even in winter. There are seeds that take long to grow.", author: "Seneca", source: "Letters to Lucilius, 23.10", theme: "Persistence", phase: 3 },
  { dayNumber: 177, quote: "The world turns aside to let any man pass who knows where he is going.", author: "Epictetus", source: "Discourses, 3.22", theme: "Direction and Purpose", phase: 3 },
  { dayNumber: 178, quote: "Work out your own salvation. Do not depend on others.", author: "Epictetus", source: "Enchiridion, 36", theme: "Self-Reliance", phase: 3 },
  { dayNumber: 179, quote: "Make yourself a craftsman in speaking and in acting — then trust the result to the universe.", author: "Marcus Aurelius", source: "Meditations, 10.4", theme: "Craft and Release", phase: 3 },
  { dayNumber: 180, quote: "Convince yourself that each day that dawns is the last you will see; then you will receive each unexpected hour as a gift.", author: "Horace", source: "Epistles, 1.4", theme: "Living Each Day Fully", phase: 3 },
  { dayNumber: 181, quote: "So it is: we are not given a short life but we make it short, and we are not ill-supplied but wasteful of it.", author: "Seneca", source: "On the Shortness of Life, 1.3", theme: "Making the Most of Life", phase: 3 },
  { dayNumber: 182, quote: "Accomplish the task before you, calmly, deliberately, without hurry.", author: "Marcus Aurelius", source: "Meditations, 8.22", theme: "Deliberate Action", phase: 3 },
  { dayNumber: 183, quote: "He is a wise man who does not grieve for the things he has not, but rejoices for those which he has.", author: "Epictetus", source: "Fragments, 28", theme: "Gratitude Over Grief", phase: 3 },
  { dayNumber: 184, quote: "So join yourself to those who will improve you.", author: "Seneca", source: "Letters to Lucilius, 7.8", theme: "Choosing Well", phase: 3 },
  { dayNumber: 185, quote: "The more we value things beyond our control, the less control we have.", author: "Epictetus", source: "Discourses, 4.4", theme: "Letting Go", phase: 3 },
  { dayNumber: 186, quote: "Man is a social animal, and must, therefore, both share his life with others and act toward the good of all.", author: "Marcus Aurelius", source: "Meditations, 5.29", theme: "Social Nature", phase: 3 },
  { dayNumber: 187, quote: "When you wake in the morning, think of what a precious privilege it is to be alive — to breathe, to think, to enjoy, to love.", author: "Marcus Aurelius", source: "Meditations, 2.1", theme: "Morning Gratitude", phase: 3 },
  { dayNumber: 188, quote: "Deliberate often; decide once.", author: "Publilius Syrus", source: "Sententiae", theme: "Think, Then Commit", phase: 3 },
  { dayNumber: 189, quote: "Be content to seem foolish and stupid to outsiders, but be wise and rational within.", author: "Epictetus", source: "Enchiridion, 13", theme: "Inner vs. Outer Reputation", phase: 3 },
  { dayNumber: 190, quote: "It is not the load that breaks you down; it is the way you carry it.", author: "Seneca", source: "Letters to Lucilius, 96.1", theme: "How We Bear Things", phase: 3 },
  { dayNumber: 191, quote: "In the midst of winter, I found there was, within me, an invincible summer.", author: "Marcus Aurelius", source: "Meditations, 5.9", theme: "Inner Summer", phase: 3 },
  { dayNumber: 192, quote: "Seek not the good in external things; seek it within yourselves.", author: "Epictetus", source: "Discourses, 3.24", theme: "Inner Good", phase: 3 },
  { dayNumber: 193, quote: "He who has a why to live can bear almost any how.", author: "Seneca", source: "Letters to Lucilius, 82.14", theme: "Purpose", phase: 3 },
  { dayNumber: 194, quote: "Small strokes fell great oaks.", author: "Marcus Aurelius", source: "Meditations, 8.7", theme: "Persistence", phase: 3 },
  { dayNumber: 195, quote: "If you see anyone weeping, be sure you offer him comfort. But when alone, practice equanimity.", author: "Epictetus", source: "Enchiridion, 16", theme: "Compassion and Equanimity", phase: 3 },
  { dayNumber: 196, quote: "Every night before going to sleep, we must ask ourselves: what weakness did I overcome today? What virtue did I acquire?", author: "Seneca", source: "On Anger, 3.36", theme: "Evening Review", phase: 3 },
  { dayNumber: 197, quote: "Think of how many things in your life would never have happened if fortune had not crossed your path, apparently against you.", author: "Marcus Aurelius", source: "Meditations, 9.42", theme: "Fortune's Hidden Gifts", phase: 3 },
  { dayNumber: 198, quote: "Act well your part; there all the honor lies.", author: "Epictetus", source: "Enchiridion, 17", theme: "Playing Your Role", phase: 3 },
  { dayNumber: 199, quote: "What is longer, a day well used or a month passed in sleep?", author: "Seneca", source: "Letters to Lucilius, 22.16", theme: "Quality of Use", phase: 3 },
  { dayNumber: 200, quote: "You are never alone. The universe carries you in its arms.", author: "Marcus Aurelius", source: "Meditations, 4.23", theme: "Belonging to the Whole", phase: 3 },

  // ── PHASE 4: WILL — Days 201–270 ─────────────────────────────────────────
  { dayNumber: 201, quote: "The obstacle is the way.", author: "Marcus Aurelius", source: "Meditations, 5.20", theme: "Amor Fati", phase: 4 },
  { dayNumber: 202, quote: "What would have become of Hercules, do you think, if there had been no lion, hydra, stag or boar, and no savage criminals to rid the world of? What would he have done in the absence of such challenges?", author: "Epictetus", source: "Discourses, 1.6", theme: "Challenges as Purpose", phase: 4 },
  { dayNumber: 203, quote: "It is not that I am brave, but that I know what is not worth fearing.", author: "Seneca", source: "Letters to Lucilius, 24.12", theme: "Courage and Perspective", phase: 4 },
  { dayNumber: 204, quote: "So you were born to feel nice? Instead of doing things and experiencing them? What are you waiting for?", author: "Marcus Aurelius", source: "Meditations, 5.1", theme: "Getting On With It", phase: 4 },
  { dayNumber: 205, quote: "Difficulties strengthen the mind, as labor does the body.", author: "Seneca", source: "Letters to Lucilius, 15.3", theme: "Difficulty as Strengthener", phase: 4 },
  { dayNumber: 206, quote: "If someone succeeds in provoking you, realize that your mind is complicit in the provocation.", author: "Epictetus", source: "Enchiridion, 20", theme: "Complicity in Provocation", phase: 4 },
  { dayNumber: 207, quote: "Model yourself on those who never stop mourning losses — but who keep going.", author: "Marcus Aurelius", source: "Meditations, 5.8", theme: "Keeping Going", phase: 4 },
  { dayNumber: 208, quote: "He who rules himself rules also the world.", author: "Seneca", source: "Letters to Lucilius, 113.28", theme: "Self-Rule as Universal Power", phase: 4 },
  { dayNumber: 209, quote: "Try to live the life of the good man who is more than content with what is dealt him.", author: "Marcus Aurelius", source: "Meditations, 7.67", theme: "Contentment With What Is", phase: 4 },
  { dayNumber: 210, quote: "When you arise in the morning, think of what a privilege it is to be alive, to think, to enjoy, to love.", author: "Marcus Aurelius", source: "Meditations, 6.2", theme: "Gratitude at Dawn", phase: 4 },
  { dayNumber: 211, quote: "Everything turns on your assumptions about it, and that's up to you. You can pluck out the hasty judgment at will, and like steering a ship in the sea, you will find calm waters.", author: "Marcus Aurelius", source: "Meditations, 9.21", theme: "Adjusting Assumptions", phase: 4 },
  { dayNumber: 212, quote: "I will keep constant watch over myself and — most usefully — will put each day up for review.", author: "Seneca", source: "Letters to Lucilius, 83.2", theme: "Daily Review", phase: 4 },
  { dayNumber: 213, quote: "Don't allow your mind to harden: to grow callous to others, or to love what cannot love you back.", author: "Marcus Aurelius", source: "Meditations, 6.39", theme: "Keeping the Heart Open", phase: 4 },
  { dayNumber: 214, quote: "Man is not born for himself. To be of service to others is nature.", author: "Seneca", source: "Letters to Lucilius, 6.4", theme: "Service", phase: 4 },
  { dayNumber: 215, quote: "The universe is transformation; life is opinion.", author: "Marcus Aurelius", source: "Meditations, 4.3", theme: "Change and Judgment", phase: 4 },
  { dayNumber: 216, quote: "It is not the load that breaks you down, it is the way you carry it.", author: "Epictetus", source: "Discourses, 3.10", theme: "How We Bear Burdens", phase: 4 },
  { dayNumber: 217, quote: "Let Fate find us prepared and active.", author: "Seneca", source: "Letters to Lucilius, 107.9", theme: "Prepared for Fate", phase: 4 },
  { dayNumber: 218, quote: "Everything can be taken from a man but one thing: the last of human freedoms — to choose one's attitude in any given set of circumstances.", author: "Epictetus", source: "Discourses, 1.1", theme: "The Final Freedom", phase: 4 },
  { dayNumber: 219, quote: "I am an old man. Let me be brief. Do not imagine that fortune will serve you forever.", author: "Seneca", source: "Letters to Lucilius, 77.1", theme: "Fortune is Fickle", phase: 4 },
  { dayNumber: 220, quote: "Poverty does not mean to have too little — it means to crave more.", author: "Seneca", source: "Letters to Lucilius, 2.6", theme: "Poverty of the Soul", phase: 4 },
  { dayNumber: 221, quote: "Nothing which has ever been will cease to have been. You can look forward to what you have already lived.", author: "Seneca", source: "Letters to Lucilius, 99.6", theme: "The Permanence of the Past", phase: 4 },
  { dayNumber: 222, quote: "Imagine for yourself a character, a model personality, whose example you determine to follow, in private as well as in public.", author: "Epictetus", source: "Enchiridion, 33", theme: "The Inner Model", phase: 4 },
  { dayNumber: 223, quote: "A ship in harbor is safe, but that is not what ships are for.", author: "Seneca", source: "Letters to Lucilius, 85.15", theme: "Risk and Purpose", phase: 4 },
  { dayNumber: 224, quote: "He suffers more than necessary, who suffers before it is necessary.", author: "Seneca", source: "Letters to Lucilius, 98.8", theme: "Preemptive Suffering", phase: 4 },
  { dayNumber: 225, quote: "Don't be overheard complaining, not even to yourself.", author: "Marcus Aurelius", source: "Meditations, 8.9", theme: "No Complaining", phase: 4 },
  { dayNumber: 226, quote: "The world is a looking glass. It gives back to every man the reflection of his own face.", author: "Seneca", source: "Letters to Lucilius, 94.28", theme: "What We Project", phase: 4 },
  { dayNumber: 227, quote: "Control thy passions lest they take vengeance on thee.", author: "Epictetus", source: "Enchiridion, 2", theme: "Mastering Passion", phase: 4 },
  { dayNumber: 228, quote: "Do not be conquered by evils, but go forward with bolder face to meet them.", author: "Marcus Aurelius", source: "Meditations, 6.2", theme: "Meeting Evil With Boldness", phase: 4 },
  { dayNumber: 229, quote: "We must go wherever fortune leads us — we cannot steer her, but we can trim our sails.", author: "Seneca", source: "Letters to Lucilius, 77.9", theme: "Working With Fortune", phase: 4 },
  { dayNumber: 230, quote: "To be like the cliff against which the waves continually break, but it stands firm and tames the fury of the water around it.", author: "Marcus Aurelius", source: "Meditations, 4.49", theme: "Unshakeable Steadiness", phase: 4 },
  { dayNumber: 231, quote: "You must live in the present, launch yourself on every wave, find your eternity in each moment.", author: "Seneca", source: "Letters to Lucilius, 101.10", theme: "The Eternal Present", phase: 4 },
  { dayNumber: 232, quote: "Endure and abstain. These are the two watchwords of the Stoics.", author: "Epictetus", source: "Fragments, 10", theme: "Endurance and Abstinence", phase: 4 },
  { dayNumber: 233, quote: "If you have two loaves of bread, sell one and buy some hyacinths — for the hyacinths will feed the soul.", author: "Seneca", source: "Letters to Lucilius, 62.3", theme: "Beauty as Necessity", phase: 4 },
  { dayNumber: 234, quote: "Men seek retreats for themselves — in the country, by the sea, in the hills. But all of this is unphilosophical. You can find retreat wherever you like, for a man can retire into himself at any moment.", author: "Marcus Aurelius", source: "Meditations, 4.3", theme: "Retreat Into Self", phase: 4 },
  { dayNumber: 235, quote: "What is life? A flash of light. What is it? The shadow of a shadow.", author: "Seneca", source: "Consolation to Polybius, 9.6", theme: "The Brevity of Life", phase: 4 },
  { dayNumber: 236, quote: "Either suffering must come to an end, or one will no longer feel it.", author: "Epictetus", source: "Discourses, 2.1", theme: "The Limit of Suffering", phase: 4 },
  { dayNumber: 237, quote: "Every trouble comes to pass. Nothing is so lasting as people fear.", author: "Seneca", source: "Letters to Lucilius, 24.20", theme: "Nothing Lasts", phase: 4 },
  { dayNumber: 238, quote: "You have power over your mind — not outside events. Realize this, and you will find strength.", author: "Marcus Aurelius", source: "Meditations, 6.52", theme: "The Mind's Power", phase: 4 },
  { dayNumber: 239, quote: "If the iron is straight, what does it matter whether it is black or white?", author: "Seneca", source: "Letters to Lucilius, 66.7", theme: "Character Over Appearance", phase: 4 },
  { dayNumber: 240, quote: "Amor fati — love your fate. Do not merely bear your fate; love it.", author: "Marcus Aurelius", source: "Meditations, 6.39", theme: "Loving Your Fate", phase: 4 },
  { dayNumber: 241, quote: "The whole secret of existence is to have no fear.", author: "Epictetus", source: "Discourses, 1.29", theme: "Fearlessness", phase: 4 },
  { dayNumber: 242, quote: "Poverty is not having too little; it is wanting more.", author: "Seneca", source: "Letters to Lucilius, 2.6", theme: "Redefining Poverty", phase: 4 },
  { dayNumber: 243, quote: "In nothing do we come nearer to the gods than in doing good to men.", author: "Marcus Aurelius", source: "Meditations, 9.1", theme: "Doing Good", phase: 4 },
  { dayNumber: 244, quote: "Ask yourself if you are living well, and be honest.", author: "Seneca", source: "Letters to Lucilius, 16.1", theme: "Honest Self-Examination", phase: 4 },
  { dayNumber: 245, quote: "Know this first: the secret of happiness is not in having what you want — it is in wanting what you have.", author: "Epictetus", source: "Discourses, 3.24", theme: "Wanting What You Have", phase: 4 },
  { dayNumber: 246, quote: "Take care of your body as if you were going to live forever; and take care of your soul as if you were going to die tomorrow.", author: "Seneca", source: "Letters to Lucilius, 78.1", theme: "Body and Soul", phase: 4 },
  { dayNumber: 247, quote: "The art of living is more like wrestling than dancing.", author: "Marcus Aurelius", source: "Meditations, 7.61", theme: "Life Requires Strength", phase: 4 },
  { dayNumber: 248, quote: "Remember: you are an actor in a play. The play is life. Your role is assigned by the director — whether it is short or long, whether you play a poor man or a king.", author: "Epictetus", source: "Enchiridion, 17", theme: "Playing Your Part", phase: 4 },
  { dayNumber: 249, quote: "Associate with those who will make you better.", author: "Seneca", source: "Letters to Lucilius, 7.8", theme: "Choose Your Company", phase: 4 },
  { dayNumber: 250, quote: "In fair weather, prepare for foul.", author: "Seneca", source: "Letters to Lucilius, 4.7", theme: "Negative Visualization", phase: 4 },
  { dayNumber: 251, quote: "It is easy — terribly easy — to shake a man's faith in himself. To take advantage of that to break a man's spirit is devil's work.", author: "Seneca", source: "On Benefits, 2.28", theme: "Protecting Human Dignity", phase: 4 },
  { dayNumber: 252, quote: "Retreat into yourself as often as you can; choose your company with those who will improve you.", author: "Seneca", source: "Letters to Lucilius, 7.8", theme: "Choosing the Right Company", phase: 4 },
  { dayNumber: 253, quote: "Where is the good? In knowledge. Where is evil? In ignorance. Everything else is nothing.", author: "Epictetus", source: "Enchiridion, 5", theme: "Good and Evil in Knowledge", phase: 4 },
  { dayNumber: 254, quote: "Look within. For within is the fountain of good, and it will ever bubble up, if thou wilt ever dig.", author: "Marcus Aurelius", source: "Meditations, 7.59", theme: "The Inner Fountain", phase: 4 },
  { dayNumber: 255, quote: "Nothing, to my way of thinking, is a better proof of a well-ordered mind than a man's ability to stop just where he is and pass some time in his own company.", author: "Seneca", source: "Letters to Lucilius, 2.1", theme: "Comfort in One's Own Company", phase: 4 },
  { dayNumber: 256, quote: "Waste not a single day mourning the past. It is gone. Use what remains.", author: "Marcus Aurelius", source: "Meditations, 9.3", theme: "Not Mourning the Past", phase: 4 },
  { dayNumber: 257, quote: "True wisdom comes to each of us when we realize how little we understand about life, ourselves, and the world around us.", author: "Marcus Aurelius", source: "Meditations, 4.3", theme: "Wisdom and Humility", phase: 4 },
  { dayNumber: 258, quote: "We should hunt out the helpful pieces of teaching and the spirited and noble-minded sayings which are capable of immediate practical application, not far-fetched or archaic expressions or extravagant metaphors.", author: "Seneca", source: "Letters to Lucilius, 33.6", theme: "Practical Wisdom", phase: 4 },
  { dayNumber: 259, quote: "To be capable of steady friendship or steady love is a noble thing.", author: "Seneca", source: "Letters to Lucilius, 3.3", theme: "Steadiness in Love", phase: 4 },
  { dayNumber: 260, quote: "We are all swimming toward the same shore.", author: "Seneca", source: "Letters to Lucilius, 77.19", theme: "Common Destiny", phase: 4 },
  { dayNumber: 261, quote: "Who begins too much accomplishes little.", author: "Epictetus", source: "Discourses, 4.8", theme: "Focus Over Ambition", phase: 4 },
  { dayNumber: 262, quote: "Unhappiness is caused by unmet expectations.", author: "Epictetus", source: "Discourses, 4.1", theme: "Expectations", phase: 4 },
  { dayNumber: 263, quote: "The wise man need not run ahead of time; it is enough to keep pace with it.", author: "Seneca", source: "Letters to Lucilius, 3.6", theme: "Pace and Time", phase: 4 },
  { dayNumber: 264, quote: "Joy for the present; equanimity for the future.", author: "Marcus Aurelius", source: "Meditations, 12.23", theme: "Joy and Equanimity", phase: 4 },
  { dayNumber: 265, quote: "The noble-minded man, wherever he is, and under whatever conditions, preserves his character.", author: "Epictetus", source: "Discourses, 2.9", theme: "Consistent Character", phase: 4 },
  { dayNumber: 266, quote: "The whole life of man is but a point of time; let us enjoy it, therefore, while it lasts.", author: "Seneca", source: "On the Happy Life, 28.5", theme: "Enjoy This Moment", phase: 4 },
  { dayNumber: 267, quote: "We have been born once; we cannot be born a second time, and for all eternity there will be no second chance.", author: "Epicurus (embraced by Seneca)", source: "Letters to Lucilius, 21.5", theme: "One Chance at Life", phase: 4 },
  { dayNumber: 268, quote: "One day you will look back and realize this day was an ordinary miracle.", author: "Marcus Aurelius", source: "Meditations, 7.9", theme: "The Ordinary Miracle", phase: 4 },
  { dayNumber: 269, quote: "Receive every injury as it were in passing, and rise above it.", author: "Seneca", source: "On Anger, 3.25", theme: "Rising Above Injury", phase: 4 },
  { dayNumber: 270, quote: "Whatever you are rightly doing, have the courage to continue without looking to see who is watching.", author: "Marcus Aurelius", source: "Meditations, 3.16", theme: "Right Action Without Audience", phase: 4 },

  // ── PHASE 5: VIRTUE — Days 271–330 ───────────────────────────────────────
  { dayNumber: 271, quote: "Be worthy of your own company.", author: "Marcus Aurelius", source: "Meditations, 4.3", theme: "Self-Respect", phase: 5 },
  { dayNumber: 272, quote: "The four virtues: wisdom, justice, courage, and self-discipline. All else is lesser.", author: "Epictetus", source: "Discourses, 1.20", theme: "The Four Virtues", phase: 5 },
  { dayNumber: 273, quote: "It is good to have a mind that does not waver under hardship.", author: "Seneca", source: "Letters to Lucilius, 66.4", theme: "Steadiness", phase: 5 },
  { dayNumber: 274, quote: "Do what nature requires. Get started right away — if at all possible.", author: "Marcus Aurelius", source: "Meditations, 8.7", theme: "Nature's Requirements", phase: 5 },
  { dayNumber: 275, quote: "A great city, like a great man, always has something left to discover.", author: "Seneca", source: "Letters to Lucilius, 77.20", theme: "Depth of Character", phase: 5 },
  { dayNumber: 276, quote: "The wise man will not begin to act unless he knows he will be able to finish.", author: "Epictetus", source: "Enchiridion, 29", theme: "Commitment to Follow-Through", phase: 5 },
  { dayNumber: 277, quote: "If you would be good, first believe that you are bad.", author: "Epictetus", source: "Enchiridion, 5", theme: "Honest Self-Appraisal", phase: 5 },
  { dayNumber: 278, quote: "We must learn how to wish for things to happen as they do, not as we would like them to.", author: "Epictetus", source: "Enchiridion, 8", theme: "Aligning Desires With Reality", phase: 5 },
  { dayNumber: 279, quote: "He who is virtuous is wise, and he who is wise is good, and he who is good is happy.", author: "Seneca", source: "Letters to Lucilius, 76.8", theme: "The Chain of Virtue", phase: 5 },
  { dayNumber: 280, quote: "Among the many vices that surround a man, the greatest is the belief that he cannot do better.", author: "Marcus Aurelius", source: "Meditations, 7.3", theme: "Refusing Hopelessness", phase: 5 },
  { dayNumber: 281, quote: "Character is something that is not given, but achieved.", author: "Seneca", source: "Letters to Lucilius, 11.10", theme: "Character is Earned", phase: 5 },
  { dayNumber: 282, quote: "I will not be ashamed to point out even what is obvious, if it has been overlooked.", author: "Seneca", source: "Letters to Lucilius, 4.1", theme: "Courage to Speak", phase: 5 },
  { dayNumber: 283, quote: "Make friends with the idea that change is as natural as the seasons.", author: "Marcus Aurelius", source: "Meditations, 9.28", theme: "Change Is Natural", phase: 5 },
  { dayNumber: 284, quote: "The good person differs from the crowd in this: he accepts what comes, exactly as it arrives.", author: "Seneca", source: "Letters to Lucilius, 85.17", theme: "Accepting What Comes", phase: 5 },
  { dayNumber: 285, quote: "Think of yourself not as a mere man, but as one who plays a part in a great drama.", author: "Epictetus", source: "Enchiridion, 17", theme: "The Role We Play", phase: 5 },
  { dayNumber: 286, quote: "Wisdom brings equanimity. Wealth brings anxiety. Know the difference.", author: "Seneca", source: "Letters to Lucilius, 5.7", theme: "Wisdom vs. Wealth", phase: 5 },
  { dayNumber: 287, quote: "The sun also rises on the wicked. The sun also sets on the righteous. Nature plays no favorites.", author: "Seneca", source: "On Benefits, 4.26", theme: "Nature's Impartiality", phase: 5 },
  { dayNumber: 288, quote: "A man should be upright — not kept upright.", author: "Marcus Aurelius", source: "Meditations, 3.5", theme: "Self-Uprightness", phase: 5 },
  { dayNumber: 289, quote: "You can endure anything your mind can make endurable, by treating it as an interest rather than a burden.", author: "Seneca", source: "Letters to Lucilius, 78.14", theme: "Reframing Endurance", phase: 5 },
  { dayNumber: 290, quote: "Let your deeds be your words, and your character your greatest argument.", author: "Epictetus", source: "Discourses, 3.1", theme: "Deeds Over Words", phase: 5 },
  { dayNumber: 291, quote: "Give yourself time to learn something worth knowing. Haste makes waste — of a life.", author: "Seneca", source: "Letters to Lucilius, 45.1", theme: "Patience and Learning", phase: 5 },
  { dayNumber: 292, quote: "Friendship is created, not found. It takes time, trust, and shared trial.", author: "Seneca", source: "Letters to Lucilius, 3.2", theme: "Friendship", phase: 5 },
  { dayNumber: 293, quote: "The marks of good character are: concern for the welfare of others; not putting personal interest above that of the common good; and the capacity to be genuinely pleased by another's virtue.", author: "Marcus Aurelius", source: "Meditations, 5.31", theme: "Marks of Good Character", phase: 5 },
  { dayNumber: 294, quote: "Leave aside the question of being honored — be worthy of honor.", author: "Epictetus", source: "Discourses, 4.5", theme: "Worthiness Over Honor", phase: 5 },
  { dayNumber: 295, quote: "It is the privilege of wisdom to love its neighbor, even when the neighbor is a fool.", author: "Seneca", source: "Letters to Lucilius, 48.2", theme: "Loving the Neighbor", phase: 5 },
  { dayNumber: 296, quote: "How long are you going to wait before you demand the best for yourself?", author: "Epictetus", source: "Discourses, 1.2", theme: "Demanding the Best From Yourself", phase: 5 },
  { dayNumber: 297, quote: "The final goal of philosophy: to grow in goodness, and to help others do the same.", author: "Seneca", source: "Letters to Lucilius, 6.4", theme: "The Purpose of Philosophy", phase: 5 },
  { dayNumber: 298, quote: "Let every day be a good day, taken completely, undiminished.", author: "Marcus Aurelius", source: "Meditations, 7.17", theme: "The Complete Day", phase: 5 },
  { dayNumber: 299, quote: "Be master of your will; be indifferent to what is not in your power.", author: "Epictetus", source: "Enchiridion, 1", theme: "The Two Domains", phase: 5 },
  { dayNumber: 300, quote: "A good character is, in fact, the fruit of the love of wisdom, and a love of wisdom the fruit of study.", author: "Seneca", source: "Letters to Lucilius, 76.5", theme: "Character From Wisdom", phase: 5 },
  { dayNumber: 301, quote: "Fate leads the willing, and drags along the reluctant.", author: "Seneca", source: "Letters to Lucilius, 107.11", theme: "Willing Acceptance of Fate", phase: 5 },
  { dayNumber: 302, quote: "Nothing will ever be attempted if all possible objections must first be overcome.", author: "Seneca", source: "Letters to Lucilius, 82.12", theme: "Beginning Anyway", phase: 5 },
  { dayNumber: 303, quote: "Consider that everything is opinion and opinion is in your power. Take away your opinion and there is taken away the complaint: 'I am hurt.'", author: "Marcus Aurelius", source: "Meditations, 12.22", theme: "Opinion as the Root", phase: 5 },
  { dayNumber: 304, quote: "The virtuous man is happy without making a display of it. Happy because he serves others.", author: "Seneca", source: "Letters to Lucilius, 23.3", theme: "Quiet Virtue", phase: 5 },
  { dayNumber: 305, quote: "Do good and do it now, today, not tomorrow, not after some difficulty passes.", author: "Marcus Aurelius", source: "Meditations, 4.17", theme: "Doing Good Now", phase: 5 },
  { dayNumber: 306, quote: "It takes time to make a friendship firm. The man who has been your friend for only a day has not yet been your friend at all.", author: "Seneca", source: "Letters to Lucilius, 3.3", theme: "Friendship Requires Time", phase: 5 },
  { dayNumber: 307, quote: "Love those who are connected to you by circumstance. They are yours in the deepest sense.", author: "Marcus Aurelius", source: "Meditations, 6.39", theme: "Loving What Is Yours", phase: 5 },
  { dayNumber: 308, quote: "Philosophy makes us equal. It erases the differences that fortune has imposed.", author: "Seneca", source: "Letters to Lucilius, 44.1", theme: "Philosophy as Equalizer", phase: 5 },
  { dayNumber: 309, quote: "Virtue has no masters. She is free. She chooses whom she will.", author: "Epictetus", source: "Discourses, 1.19", theme: "Virtue's Freedom", phase: 5 },
  { dayNumber: 310, quote: "Care for others' welfare as if it were your own, yet always without losing yourself.", author: "Marcus Aurelius", source: "Meditations, 6.7", theme: "Care Without Loss of Self", phase: 5 },
  { dayNumber: 311, quote: "We need not wait for old age to be wise. The youth who grasps this principle is already ancient.", author: "Seneca", source: "Letters to Lucilius, 32.4", theme: "Wisdom Does Not Require Age", phase: 5 },
  { dayNumber: 312, quote: "Regard your body as a tool — a means, not an end. Treat it accordingly.", author: "Epictetus", source: "Discourses, 4.11", theme: "The Body as Tool", phase: 5 },
  { dayNumber: 313, quote: "Be gentle with yourself, for you too are a traveler trying to find your way home.", author: "Marcus Aurelius", source: "Meditations, 5.25", theme: "Self-Compassion", phase: 5 },
  { dayNumber: 314, quote: "The door stands open to you. Why do you feel trapped?", author: "Epictetus", source: "Discourses, 1.25", theme: "Freedom Is Always Available", phase: 5 },
  { dayNumber: 315, quote: "There is nothing in the world so much admired as a man who knows how to bear unhappiness with courage.", author: "Seneca", source: "Letters to Lucilius, 66.7", theme: "Bearing Unhappiness With Dignity", phase: 5 },
  { dayNumber: 316, quote: "No man was ever wise by chance.", author: "Seneca", source: "Letters to Lucilius, 76.6", theme: "Wisdom Requires Intention", phase: 5 },
  { dayNumber: 317, quote: "If you see a man taking risks for what is right, do not say he lacks wisdom. Say he has it in the fullest measure.", author: "Seneca", source: "Letters to Lucilius, 67.7", theme: "Courage and Wisdom", phase: 5 },
  { dayNumber: 318, quote: "I do not value what I have so much that I would keep it at the cost of my self-respect.", author: "Marcus Aurelius", source: "Meditations, 3.7", theme: "Self-Respect Over Possessions", phase: 5 },
  { dayNumber: 319, quote: "I strive to reach the utmost limit of my power. I aim beyond my present self.", author: "Seneca", source: "Letters to Lucilius, 76.1", theme: "Striving Beyond the Present Self", phase: 5 },
  { dayNumber: 320, quote: "Be kind, for everyone you meet is fighting a hard battle.", author: "Marcus Aurelius", source: "Meditations, 6.31", theme: "Universal Struggle", phase: 5 },
  { dayNumber: 321, quote: "Nothing is so burdensome as a man who will not let go of the past.", author: "Seneca", source: "On Anger, 3.39", theme: "Letting Go of the Past", phase: 5 },
  { dayNumber: 322, quote: "You are a citizen of the universe, not of Rome, not of Athens — of the whole.", author: "Epictetus", source: "Discourses, 1.9", theme: "Cosmopolitan Identity", phase: 5 },
  { dayNumber: 323, quote: "The good man is he who can be good in any circumstance.", author: "Marcus Aurelius", source: "Meditations, 6.2", theme: "Goodness in All Circumstances", phase: 5 },
  { dayNumber: 324, quote: "It does not matter where you go. You carry yourself with you.", author: "Seneca", source: "Letters to Lucilius, 28.2", theme: "You Take Yourself Everywhere", phase: 5 },
  { dayNumber: 325, quote: "He who is everywhere is nowhere. Those who spend their life in travel find at last that they have had many places to stay but no real home.", author: "Seneca", source: "Letters to Lucilius, 2.2", theme: "Rootedness", phase: 5 },
  { dayNumber: 326, quote: "The just man is he who fulfills his duties to himself and others without harm to either.", author: "Marcus Aurelius", source: "Meditations, 5.34", theme: "Justice", phase: 5 },
  { dayNumber: 327, quote: "The man who does not give will never have enough, even if he has the whole world.", author: "Seneca", source: "Letters to Lucilius, 83.26", theme: "Generosity", phase: 5 },
  { dayNumber: 328, quote: "To love another person is to see the face of God.", author: "Epictetus", source: "Discourses, 1.9", theme: "The Divinity in Love", phase: 5 },
  { dayNumber: 329, quote: "Everywhere, at each moment, you have the option: to accept this event with humility, to treat this person with kindness, to approach this challenge with a calm mind.", author: "Marcus Aurelius", source: "Meditations, 9.7", theme: "The Perennial Option", phase: 5 },
  { dayNumber: 330, quote: "A good life is one in which you are neither enslaved to pleasure nor estranged from it, but free of both.", author: "Seneca", source: "Letters to Lucilius, 23.3", theme: "Freedom From and For Pleasure", phase: 5 },

  // ── PHASE 6: THE VIEW FROM ABOVE — Days 331–365 ───────────────────────────
  { dayNumber: 331, quote: "Look at the whole of time and space and see that compared to them, individual things are infinitely small.", author: "Marcus Aurelius", source: "Meditations, 9.32", theme: "Cosmic Perspective", phase: 6 },
  { dayNumber: 332, quote: "All is vanity. And what is not vanity? To love God and to serve only him.", author: "Seneca", source: "Letters to Lucilius, 77.18", theme: "What Endures", phase: 6 },
  { dayNumber: 333, quote: "Human life is nearly nothing compared with immensity. But that nearly nothing is our whole world. Cherish it.", author: "Epictetus", source: "Discourses, 2.5", theme: "The Weight of Smallness", phase: 6 },
  { dayNumber: 334, quote: "From above — the boundless sea of time behind and before, and the little that separates us from the rest.", author: "Marcus Aurelius", source: "Meditations, 9.30", theme: "Time's Boundlessness", phase: 6 },
  { dayNumber: 335, quote: "Think how many Platos and Aristotles, how many Alexanders and Caesars have risen and fallen. One generation replaces another. Each thinks the world began with it and ends with it.", author: "Seneca", source: "Letters to Lucilius, 77.20", theme: "The Parade of Generations", phase: 6 },
  { dayNumber: 336, quote: "Thou art a little soul bearing a corpse, as Epictetus used to say.", author: "Epictetus", source: "Fragments, 26", theme: "The Lightness of Life", phase: 6 },
  { dayNumber: 337, quote: "The Milky Way, the planets, the universe — an insignificant point in all of space. And you, fretting about your reputation at the office.", author: "Marcus Aurelius", source: "Meditations, 8.21", theme: "Perspective on Reputation", phase: 6 },
  { dayNumber: 338, quote: "Let us prepare our minds as if we had come to the very end of life. Let us postpone nothing. Let us balance life's books each day.", author: "Seneca", source: "Letters to Lucilius, 101.7", theme: "Living as if at the End", phase: 6 },
  { dayNumber: 339, quote: "From on high, look down. Herds of beasts; crowds of men; ceremonials; ships; whatever you can imagine: all of it trifling, all of it transient.", author: "Marcus Aurelius", source: "Meditations, 9.30", theme: "The View From Above", phase: 6 },
  { dayNumber: 340, quote: "Death is the undiscovered country, but every wise man has already visited it in imagination many times.", author: "Seneca", source: "Letters to Lucilius, 26.4", theme: "Preparation for Death", phase: 6 },
  { dayNumber: 341, quote: "I am a citizen of the universe. I share the same reason as God. I am kin to every human being. What injures them injures me.", author: "Marcus Aurelius", source: "Meditations, 4.4", theme: "Kinship With All", phase: 6 },
  { dayNumber: 342, quote: "All that is human is transient and perishable, all that belongs to fortune is uncertain. Of this and this alone are we certain: we shall die.", author: "Seneca", source: "Letters to Lucilius, 101.8", theme: "The Certainty of Death", phase: 6 },
  { dayNumber: 343, quote: "Everything is opinion, and opinion can be changed. What troubles you is not things, but your thoughts about things.", author: "Epictetus", source: "Enchiridion, 5", theme: "The Malleability of Opinion", phase: 6 },
  { dayNumber: 344, quote: "How brief, how paltry is the life of man — yesterday a drop of semen, tomorrow a handful of spice and ashes. Pass through this little time in conformity with nature, and end your journey in content.", author: "Marcus Aurelius", source: "Meditations, 4.48", theme: "The Briefness of a Life", phase: 6 },
  { dayNumber: 345, quote: "The whole earth is nothing but a point — and what portion of it is the habitation of man?", author: "Seneca", source: "Letters to Lucilius, 102.21", theme: "The Smallness of the World", phase: 6 },
  { dayNumber: 346, quote: "Whoever leads a good life suffers no shortage of time.", author: "Seneca", source: "Letters to Lucilius, 77.20", theme: "A Good Life Is Complete", phase: 6 },
  { dayNumber: 347, quote: "All that you see is the work of one mind — time and circumstance and human nature woven together in a single cloth.", author: "Marcus Aurelius", source: "Meditations, 6.38", theme: "The Weave of Everything", phase: 6 },
  { dayNumber: 348, quote: "You will find rest from vain fancies if you perform every act in life as though it were your last.", author: "Marcus Aurelius", source: "Meditations, 2.14", theme: "Presence as Relief", phase: 6 },
  { dayNumber: 349, quote: "The life of the dead is placed in the memory of the living.", author: "Seneca", source: "Letters to Lucilius, 77.11", theme: "Memory and Legacy", phase: 6 },
  { dayNumber: 350, quote: "This above all: to thine own self be true, and it must follow, as the night the day, thou canst not then be false to any man.", author: "Epictetus", source: "Discourses, 3.23", theme: "Authenticity", phase: 6 },
  { dayNumber: 351, quote: "Time heals what reason cannot. And reason teaches us to use time well.", author: "Seneca", source: "Letters to Lucilius, 63.11", theme: "Time and Reason", phase: 6 },
  { dayNumber: 352, quote: "Look at the past — empire after empire, dynasty after dynasty. Where are they now? None.", author: "Marcus Aurelius", source: "Meditations, 4.32", theme: "Nothing Is Permanent", phase: 6 },
  { dayNumber: 353, quote: "Time — the greatest and most misunderstood of all things. We all have it. Almost none of us use it well.", author: "Seneca", source: "On the Shortness of Life, 1.1", theme: "The Mystery of Time", phase: 6 },
  { dayNumber: 354, quote: "The day which you fear as being the end of all things is the birthday of your eternity.", author: "Seneca", source: "Letters to Lucilius, 102.26", theme: "Death as Threshold", phase: 6 },
  { dayNumber: 355, quote: "Everything is change. Nothing passes away. Nature only transforms.", author: "Marcus Aurelius", source: "Meditations, 6.15", theme: "Transformation Not Disappearance", phase: 6 },
  { dayNumber: 356, quote: "How foolish to think of what might have been, and neglect what is.", author: "Seneca", source: "Letters to Lucilius, 3.8", theme: "The Actual Over the Hypothetical", phase: 6 },
  { dayNumber: 357, quote: "What you leave behind is not what is engraved in stone monuments, but what is woven into the lives of others.", author: "Epictetus", source: "Discourses, 4.5", theme: "Legacy", phase: 6 },
  { dayNumber: 358, quote: "Meditate often on the swiftness with which the things that exist and that are coming into existence are swept past us and carried away.", author: "Marcus Aurelius", source: "Meditations, 9.28", theme: "The Speed of Time", phase: 6 },
  { dayNumber: 359, quote: "If you wish to have leisure for your mind, either be a poor man or be like a poor man. Study cannot be helpful unless you take some time away from other things — and, first of all, from business.", author: "Seneca", source: "Letters to Lucilius, 17.5", theme: "Simplicity and the Life of the Mind", phase: 6 },
  { dayNumber: 360, quote: "We are all portions of one great body. Nature made us kin when she fashioned us from the same elements and for the same ends.", author: "Seneca", source: "Letters to Lucilius, 95.52", theme: "Universal Kinship", phase: 6 },
  { dayNumber: 361, quote: "What difference is there between the fates of those who lived a short time and those who lived long? When you are dead, you are dead as long as dead lasts.", author: "Seneca", source: "Letters to Lucilius, 77.10", theme: "The Equality of Death", phase: 6 },
  { dayNumber: 362, quote: "Think of the past as borrowed; think of the present as a gift; think of the future as unknown.", author: "Marcus Aurelius", source: "Meditations, 6.39", theme: "Three Tenses of Time", phase: 6 },
  { dayNumber: 363, quote: "Not to live forever — but to have really lived.", author: "Seneca", source: "Letters to Lucilius, 77.20", theme: "The Quality of a Life", phase: 6 },
  { dayNumber: 364, quote: "All things are parts of one single system, which is called nature; the individual life is good when it is in harmony with nature.", author: "Marcus Aurelius", source: "Meditations, 6.38", theme: "Harmony With Nature", phase: 6 },
  { dayNumber: 365, quote: "We have lived. We have done our work. We have loved. We will be remembered. We will return to the whole from which we came.", author: "Marcus Aurelius", source: "Meditations, 9.3", theme: "The Full Circle", phase: 6 },
];

// ── Alternative Morning Quote Track ────────────────────────────────────────────

const ALTERNATIVE_QUOTES = [
  { quote: "The present moment always will have been.", author: "Marcus Aurelius", source: "Meditations", theme: "Presence" },
  { quote: "You have power over your mind, not outside events. Realize this, and you will find strength.", author: "Marcus Aurelius", source: "Meditations", theme: "Inner Strength" },
  { quote: "The happiness of your life depends upon the quality of your thoughts.", author: "Marcus Aurelius", source: "Meditations", theme: "Mindset" },
  { quote: "Very little is needed to make a happy life; it is all within yourself, in your way of thinking.", author: "Marcus Aurelius", source: "Meditations", theme: "Simplicity" },
  { quote: "Waste no more time arguing about what a good man should be. Be one.", author: "Marcus Aurelius", source: "Meditations", theme: "Action" },
  { quote: "When you arise in the morning, think of what a precious privilege it is to be alive — to breathe, to think, to enjoy, to love.", author: "Marcus Aurelius", source: "Meditations", theme: "Gratitude" },
  { quote: "He who is not a good servant will not be a good master.", author: "Plato", source: "Laws", theme: "Leadership" },
  { quote: "We are what we repeatedly do. Excellence, then, is not an act but a habit.", author: "Aristotle", source: "Nicomachean Ethics", theme: "Habit" },
  { quote: "Knowing yourself is the beginning of all wisdom.", author: "Aristotle", source: "Nicomachean Ethics", theme: "Self-Knowledge" },
  { quote: "It is not enough to do good; one must do it the right way.", author: "John Morley", source: "On Compromise", theme: "Integrity" },
  { quote: "In the middle of difficulty lies opportunity.", author: "Albert Einstein", source: "Letter, 1945", theme: "Resilience" },
  { quote: "Do what you can, with what you have, where you are.", author: "Theodore Roosevelt", source: "Autobiography", theme: "Action" },
  { quote: "It does not matter how slowly you go as long as you do not stop.", author: "Confucius", source: "Analects", theme: "Persistence" },
  { quote: "Our greatest glory is not in never falling, but in rising every time we fall.", author: "Confucius", source: "Analects", theme: "Resilience" },
  { quote: "Before you embark on a journey of revenge, dig two graves.", author: "Confucius", source: "Analects", theme: "Letting Go" },
  { quote: "The man who moves a mountain begins by carrying away small stones.", author: "Confucius", source: "Analects", theme: "Persistence" },
  { quote: "Life is really simple, but we insist on making it complicated.", author: "Confucius", source: "Analects", theme: "Simplicity" },
  { quote: "Not all those who wander are lost.", author: "J.R.R. Tolkien", source: "The Fellowship of the Ring", theme: "Purpose" },
  { quote: "The secret of getting ahead is getting started.", author: "Mark Twain", source: "Notebook", theme: "Action" },
  { quote: "The two most important days in your life are the day you are born and the day you find out why.", author: "Mark Twain", source: "Notebook", theme: "Purpose" },
  { quote: "Courage is not the absence of fear but the judgment that something else is more important than fear.", author: "Ambrose Redmoon", source: "No Peaceful Warriors", theme: "Courage" },
  { quote: "Start where you are. Use what you have. Do what you can.", author: "Arthur Ashe", source: "Speech, 1992", theme: "Action" },
  { quote: "You miss 100% of the shots you don't take.", author: "Wayne Gretzky", source: "Interview", theme: "Courage" },
  { quote: "Whether you think you can or think you can't, you're right.", author: "Henry Ford", source: "Interview", theme: "Mindset" },
  { quote: "The only way to do great work is to love what you do.", author: "Steve Jobs", source: "Stanford Commencement, 2005", theme: "Purpose" },
  { quote: "In three words I can sum up everything I've learned about life: it goes on.", author: "Robert Frost", source: "Interview", theme: "Resilience" },
  { quote: "To be yourself in a world that is constantly trying to make you something else is the greatest accomplishment.", author: "Ralph Waldo Emerson", source: "Self-Reliance", theme: "Authenticity" },
  { quote: "What lies behind us and what lies before us are tiny matters compared to what lies within us.", author: "Ralph Waldo Emerson", source: "Essays", theme: "Inner Strength" },
  { quote: "The only person you are destined to become is the person you decide to be.", author: "Ralph Waldo Emerson", source: "Essays", theme: "Self-Determination" },
  { quote: "Nothing is particularly hard if you divide it into small jobs.", author: "Henry Ford", source: "My Life and Work", theme: "Persistence" },
  { quote: "A year from now you may wish you had started today.", author: "Karen Lamb", source: "Essays", theme: "Action" },
  { quote: "The mind is everything. What you think you become.", author: "Buddha", source: "Dhammapada", theme: "Mindset" },
  { quote: "Three things cannot be long hidden: the sun, the moon, and the truth.", author: "Buddha", source: "Dhammapada", theme: "Truth" },
  { quote: "Peace comes from within. Do not seek it without.", author: "Buddha", source: "Dhammapada", theme: "Inner Peace" },
  { quote: "Do not dwell in the past, do not dream of the future, concentrate the mind on the present moment.", author: "Buddha", source: "Dhammapada", theme: "Presence" },
  { quote: "Health is the greatest gift, contentment the greatest wealth, faithfulness the best relationship.", author: "Buddha", source: "Dhammapada", theme: "Gratitude" },
  { quote: "The journey of a thousand miles begins with one step.", author: "Lao Tzu", source: "Tao Te Ching", theme: "Action" },
  { quote: "Nature does not hurry, yet everything is accomplished.", author: "Lao Tzu", source: "Tao Te Ching", theme: "Patience" },
  { quote: "Simplicity is the ultimate sophistication.", author: "Leonardo da Vinci", source: "Notebooks", theme: "Simplicity" },
  { quote: "You cannot step into the same river twice.", author: "Heraclitus", source: "Fragments", theme: "Change" },
  { quote: "Character is destiny.", author: "Heraclitus", source: "Fragments", theme: "Character" },
  { quote: "Big things are accomplished only through the perfection of minor details.", author: "John Wooden", source: "They Call Me Coach", theme: "Excellence" },
  { quote: "It's what you learn after you know it all that counts.", author: "John Wooden", source: "They Call Me Coach", theme: "Humility" },
  { quote: "Make each day your masterpiece.", author: "John Wooden", source: "They Call Me Coach", theme: "Presence" },
  { quote: "Talent is God-given. Be humble. Fame is man-given. Be grateful. Conceit is self-given. Be careful.", author: "John Wooden", source: "They Call Me Coach", theme: "Humility" },
  { quote: "Things which matter most must never be at the mercy of things which matter least.", author: "Johann Wolfgang von Goethe", source: "Faust", theme: "Priorities" },
  { quote: "Knowing is not enough; we must apply. Willing is not enough; we must do.", author: "Johann Wolfgang von Goethe", source: "Wilhelm Meister", theme: "Action" },
  { quote: "We know what we are, but know not what we may be.", author: "William Shakespeare", source: "Hamlet", theme: "Potential" },
  { quote: "This above all: to thine own self be true.", author: "William Shakespeare", source: "Hamlet", theme: "Authenticity" },
  { quote: "How sharper than a serpent's tooth it is to have a thankless child.", author: "William Shakespeare", source: "King Lear", theme: "Gratitude" },
];

async function seedStoicAlternatives(): Promise<void> {
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS stoic_alternatives_quote_uidx ON stoic_alternatives (quote)`);

  const values = ALTERNATIVE_QUOTES.map((_, i) => {
    const offset = i * 4;
    return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4})`;
  }).join(", ");
  const params = ALTERNATIVE_QUOTES.flatMap((q) => [q.quote, q.author, q.source, q.theme]);

  await query(
    `INSERT INTO stoic_alternatives (quote, author, source, theme)
     VALUES ${values}
     ON CONFLICT (quote) DO NOTHING`,
    params
  );
}

export async function getAlternativeStoicQuote(): Promise<{
  quote: string;
  author: string;
  source: string;
  theme: string;
} | null> {
  const { rows } = await query<{
    quote: string;
    author: string;
    source: string;
    theme: string;
  }>(
    `SELECT quote, author, source, theme
     FROM stoic_alternatives
     ORDER BY RANDOM()
     LIMIT 1`
  );
  return rows[0] ?? null;
}

// ── DB Setup ──────────────────────────────────────────────────────────────────

export async function ensureStoicTables(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS stoic_curriculum (
      id SERIAL PRIMARY KEY,
      day_number INTEGER NOT NULL UNIQUE,
      quote TEXT NOT NULL,
      author TEXT NOT NULL,
      source TEXT NOT NULL,
      theme TEXT NOT NULL,
      phase INTEGER NOT NULL,
      intro_context TEXT
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS stoic_alternatives (
      id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      quote text NOT NULL,
      author text NOT NULL,
      source text NOT NULL,
      theme text NOT NULL,
      created_at timestamptz DEFAULT now()
    )
  `);
  await seedStoicAlternatives();

  await query(`
    CREATE TABLE IF NOT EXISTS user_settings (
      id SERIAL PRIMARY KEY,
      user_name TEXT NOT NULL UNIQUE,
      stoic_day INTEGER NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const { rows } = await query<{ count: string }>(`SELECT COUNT(*) AS count FROM stoic_curriculum`);
  const count = parseInt(rows[0]?.count ?? "0", 10);

  if (count < 365) {
    logger.info({ existing: count }, "[Stoic] Seeding Stoic curriculum");
    const values = STOIC_CURRICULUM.map((e, i) => {
      const offset = i * 7;
      return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7})`;
    }).join(", ");
    const params = STOIC_CURRICULUM.flatMap((e) => [
      e.dayNumber, e.quote, e.author, e.source, e.theme, e.phase, e.introContext ?? null,
    ]);
    await query(
      `INSERT INTO stoic_curriculum (day_number, quote, author, source, theme, phase, intro_context)
       VALUES ${values}
       ON CONFLICT (day_number) DO UPDATE SET
         quote = EXCLUDED.quote, author = EXCLUDED.author, source = EXCLUDED.source,
         theme = EXCLUDED.theme, phase = EXCLUDED.phase, intro_context = EXCLUDED.intro_context`,
      params
    );
    logger.info("[Stoic] Curriculum seeded: 365 entries");
  }
}

// ── User Settings CRUD ────────────────────────────────────────────────────────

export async function getUserSettings(userName: string): Promise<UserSettings> {
  const { rows } = await query<{ stoic_day: number }>(
    `SELECT stoic_day FROM user_settings WHERE user_name = $1`,
    [userName]
  );

  if (rows.length === 0) {
    return { stoicDay: 1 };
  }

  return { stoicDay: rows[0].stoic_day };
}

// ── Stoic Entry Retrieval ─────────────────────────────────────────────────────

export async function getStoicForUser(userName: string): Promise<StoicEntry | null> {
  const settings = await getUserSettings(userName);
  const dayNum = ((settings.stoicDay - 1) % 365) + 1;

  const { rows } = await query<{
    day_number: number; quote: string; author: string;
    source: string; theme: string; phase: number; intro_context: string | null;
  }>(
    `SELECT day_number, quote, author, source, theme, phase, intro_context
     FROM stoic_curriculum WHERE day_number = $1`,
    [dayNum]
  );

  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    dayNumber: r.day_number,
    quote: r.quote,
    author: r.author,
    source: r.source,
    theme: r.theme,
    phase: r.phase,
    introContext: r.intro_context ?? undefined,
  };
}

export async function incrementStoicDay(userName: string): Promise<void> {
  await query(
    `INSERT INTO user_settings (user_name, stoic_day)
     VALUES ($1, 2)
     ON CONFLICT (user_name) DO UPDATE SET stoic_day = user_settings.stoic_day + 1, updated_at = NOW()`,
    [userName]
  );
}

// Advances stoic_day at most once per calendar day (UTC), gated atomically in
// the DB via updated_at. Call this after a quote has actually been delivered
// (e.g. in a fresh morning rundown) so the next day's read returns a new quote
// instead of repeating the same one indefinitely — without this gate, calling
// incrementStoicDay() on every rundown request would burn through the
// curriculum in hours instead of a day at a time.
export async function advanceStoicDayForNewDay(userName: string): Promise<void> {
  await query(
    `INSERT INTO user_settings (user_name, stoic_day, updated_at)
     VALUES ($1, 2, NOW())
     ON CONFLICT (user_name) DO UPDATE
       SET stoic_day = user_settings.stoic_day + 1,
           updated_at = NOW()
     WHERE user_settings.updated_at::date < NOW()::date`,
    [userName]
  );
}

// ── Stoic Block Builder ───────────────────────────────────────────────────────

export function buildStoicBlock(entry: StoicEntry): string {
  const isIntroDay = entry.dayNumber <= 7;

  let block = `\n\n[VERIFIED — Stoic Close]\n`;
  block += `Quote: "${entry.quote}"\n`;
  block += `— ${entry.author}, ${entry.source}\n`;
  block += `Theme: ${entry.theme}\n`;

  if (isIntroDay && entry.introContext) {
    block += `\nINTRO CONTEXT (deliver this BEFORE the quote — one to two sentences, warm and conversational):\n${entry.introContext}\n`;
  }

  block += `
STOIC CLOSE DELIVERY INSTRUCTIONS:
1. TRANSITION naturally into this closing — no announcement. Do not say "here is your Stoic quote" or "here is your thought for the day."
2. If this is an intro day and INTRO CONTEXT is provided, deliver it first in one to two sentences — warm, like sharing something interesting with a friend.
3. QUOTE: Deliver the quote word-for-word, attributed naturally. Examples: "As Marcus Aurelius wrote..." or "Seneca put it simply:" or "Epictetus said it plainly:"
4. TRANSLATION: In exactly ONE sentence, say what the quote means in plain everyday language. No philosophy jargon. No references to ancient Rome. Just what it means for a person waking up today.
5. INVITATION: End with a genuine, varying offer to open their Life screen to write down a thought — this should read as a real, specific offer, not a poetic aside. Vary the phrasing every time; never reuse the same sentence twice. Do not say "Have a great day" or any generic sign-off. This line is the end of the briefing.

FORBIDDEN: Do not connect the quote to anything else in the briefing — no calendar events, no news stories, no weather. The connection is the user's job, not yours. Do not add questions. Do not explain the philosophy beyond the one translation sentence. Do not reference the phase or curriculum number.
`;

  return block;
}

export async function isStoicQuoteAccessible(quote: string): Promise<boolean> {
  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 5,
      messages: [{
        role: "user",
        content: `Is this quote immediately clear and uplifting to someone who just woke up, with no historical knowledge required? Answer YES or NO only.\n\nQuote: "${quote}"`,
      }],
    });
    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("").trim().toUpperCase();
    return text.startsWith("YES");
  } catch {
    return true; // default to accessible on error — never skip the Stoic Close
  }
}
