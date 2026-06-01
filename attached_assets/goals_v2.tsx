// app/goals.tsx  (v2 — free-form chat + share button)
// Winston — Goals Screen
//
// CHANGES vs goals_fixed.tsx
//  • Uses /api/goals/chat instead of /api/goals/breakdown — free-form conversation,
//    no forced structured step output.
//  • Share button appears after the first assistant reply so the user can
//    copy/share Winston's response via the OS share sheet.
//  • Simplified state machine: goal_input → conversation (no steps_review / step_actions).
//  • "Save as Goal" button lets the user ask Winston to extract steps and save.
//  • install: npx expo install react-native-markdown-display

import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    FlatList,
    KeyboardAvoidingView,
    Platform,
    SafeAreaView,
    ScrollView,
    Share,
    StatusBar,
    StyleSheet,
    Text,
    TextInput,
    TouchableOpacity,
    View,
} from 'react-native';
import Markdown from 'react-native-markdown-display';

const SERVER = 'https://winston-server-production.up.railway.app';
const API_KEY = 'winston-native-2026';

const COLORS = {
  background: '#0A0A0F',
  surface: '#12121A',
  surfaceRaised: '#1A1A26',
  gold: '#C9A84C',
  goldLight: '#E8C96A',
  cream: '#F5F0E8',
  muted: '#8888AA',
  border: '#2A2A3A',
  green: '#4CAF50',
  blue: '#4A90D9',
  danger: '#FF6B6B',
};

const markdownStyles = {
  body: { color: COLORS.cream, fontSize: 15, lineHeight: 22 },
  heading1: { color: COLORS.gold, fontSize: 20, fontWeight: '700' as const, marginBottom: 8, marginTop: 12 },
  heading2: { color: COLORS.gold, fontSize: 17, fontWeight: '700' as const, marginBottom: 6, marginTop: 10 },
  heading3: { color: COLORS.goldLight, fontSize: 15, fontWeight: '600' as const, marginBottom: 4, marginTop: 8 },
  heading4: { color: COLORS.goldLight, fontSize: 14, fontWeight: '600' as const, marginBottom: 4, marginTop: 8 },
  strong: { color: COLORS.cream, fontWeight: '700' as const },
  em: { color: COLORS.cream, fontStyle: 'italic' as const },
  bullet_list: { marginVertical: 4 },
  ordered_list: { marginVertical: 4 },
  list_item: { marginVertical: 2, color: COLORS.cream },
  code_inline: {
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 4,
    paddingHorizontal: 4,
    color: COLORS.goldLight,
    fontSize: 13,
  },
  fence: {
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 8,
    padding: 12,
    marginVertical: 8,
    color: COLORS.goldLight,
    fontSize: 13,
  },
  blockquote: {
    borderLeftWidth: 3,
    borderLeftColor: COLORS.gold,
    paddingLeft: 12,
    marginVertical: 8,
    opacity: 0.85,
  },
  hr: { borderBottomWidth: 1, borderBottomColor: COLORS.border, marginVertical: 12 },
  link: { color: COLORS.blue },
  paragraph: { marginVertical: 4 },
};

interface GoalStep {
  id: string;
  step_text: string;
  order: number;
  completed: boolean;
  completed_at?: string;
}

interface Goal {
  id: string;
  title: string;
  description?: string;
  steps: GoalStep[];
  created_at: string;
  completed_at?: string;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

// ─── Step Row ─────────────────────────────────────────────────────────────
const StepRow = ({ step, onToggle }: { step: GoalStep; onToggle: () => void }) => (
  <TouchableOpacity style={styles.stepRow} onPress={onToggle} activeOpacity={0.7}>
    <Ionicons
      name={step.completed ? 'checkmark-circle' : 'ellipse-outline'}
      size={22}
      color={step.completed ? COLORS.green : COLORS.border}
    />
    <Text style={[styles.stepText, step.completed && styles.stepTextDone]}>
      {step.step_text}
    </Text>
  </TouchableOpacity>
);

// ─── Goal Card ────────────────────────────────────────────────────────────
const GoalCard = ({ goal, onToggleStep, onDelete, onExpand, expanded }: {
  goal: Goal;
  onToggleStep: (stepId: string, completed: boolean) => void;
  onDelete: () => void;
  onExpand: () => void;
  expanded: boolean;
}) => {
  const completedCount = goal.steps.filter(s => s.completed).length;
  const totalCount = goal.steps.length;
  const progress = totalCount > 0 ? completedCount / totalCount : 0;

  return (
    <View style={styles.goalCard}>
      <TouchableOpacity onPress={onExpand} activeOpacity={0.8}>
        <View style={styles.goalHeader}>
          <View style={{ flex: 1 }}>
            <Text style={styles.goalTitle}>{goal.title}</Text>
            {totalCount > 0 && (
              <Text style={styles.goalProgress}>{completedCount} of {totalCount} steps complete</Text>
            )}
          </View>
          <View style={styles.goalHeaderRight}>
            <TouchableOpacity onPress={onDelete} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} style={{ padding: 4 }}>
              <Ionicons name="trash-outline" size={16} color={COLORS.muted} />
            </TouchableOpacity>
            <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={16} color={COLORS.muted} />
          </View>
        </View>
        {totalCount > 0 && (
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${progress * 100}%` as any }]} />
          </View>
        )}
      </TouchableOpacity>
      {expanded && goal.steps.length > 0 && (
        <View style={styles.stepsList}>
          {goal.steps.sort((a, b) => a.order - b.order).map((step, index) => (
            <View key={step.id}>
              <StepRow step={step} onToggle={() => onToggleStep(step.id, !step.completed)} />
              {index < goal.steps.length - 1 && <View style={styles.stepDivider} />}
            </View>
          ))}
        </View>
      )}
      {expanded && goal.steps.length === 0 && (
        <Text style={styles.noStepsText}>No steps yet</Text>
      )}
    </View>
  );
};

// ─── Chat Bubble ──────────────────────────────────────────────────────────
const ChatBubble = ({
  msg,
  onShare,
}: {
  msg: ChatMessage;
  onShare?: () => void;
}) => {
  const isUser = msg.role === 'user';
  return (
    <View style={[styles.chatBubble, isUser ? styles.chatBubbleUser : styles.chatBubbleAssistant]}>
      {!isUser && (
        <View style={styles.chatBubbleTopRow}>
          <Text style={styles.chatLabel}>Winston</Text>
          {onShare && (
            <TouchableOpacity onPress={onShare} hitSlop={{ top: 8, bottom: 8, left: 12, right: 12 }}>
              <Ionicons name="share-outline" size={16} color={COLORS.muted} />
            </TouchableOpacity>
          )}
        </View>
      )}
      {isUser ? (
        <Text style={styles.chatTextUser}>{msg.content}</Text>
      ) : (
        <Markdown style={markdownStyles}>{msg.content}</Markdown>
      )}
    </View>
  );
};

// ─── Main Screen ──────────────────────────────────────────────────────────
export default function GoalsScreen() {
  const router = useRouter();
  const [goals, setGoals] = useState<Goal[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Conversation state
  const [showConversation, setShowConversation] = useState(false);
  const [goalText, setGoalText] = useState('');
  const [conversation, setConversation] = useState<ChatMessage[]>([]);
  const [isThinking, setIsThinking] = useState(false);
  const [input, setInput] = useState('');
  const [conversationPhase, setConversationPhase] = useState<'goal_input' | 'conversation'>('goal_input');
  const [pendingGoalTitle, setPendingGoalTitle] = useState('');
  const [savingGoal, setSavingGoal] = useState(false);

  const inputRef = useRef<TextInput>(null);
  const scrollRef = useRef<ScrollView>(null);

  const scrollToBottom = () => {
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 150);
  };

  const fetchGoals = useCallback(async () => {
    try {
      const res = await fetch(`${SERVER}/api/goals`, { headers: { 'x-api-key': API_KEY } });
      const data = await res.json();
      setGoals(data.goals || []);
    } catch (err) {
      console.error('Failed to fetch goals:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { fetchGoals(); }, [fetchGoals]);

  // ── Refresh goals on focus + reset conversation state on blur ──────────
  useFocusEffect(
    useCallback(() => {
      // Re-fetch goals every time the screen comes into focus so any
      // goal saved during a conversation shows up in the list immediately.
      fetchGoals();
      return () => {
        setShowConversation(false);
        setConversation([]);
        setGoalText('');
        setInput('');
        setPendingGoalTitle('');
        setConversationPhase('goal_input');
        setSavingGoal(false);
      };
    }, [fetchGoals])
  );

  const handleToggleStep = async (goalId: string, stepId: string, completed: boolean) => {
    setGoals(prev => prev.map(g =>
      g.id === goalId ? { ...g, steps: g.steps.map(s => s.id === stepId ? { ...s, completed } : s) } : g
    ));
    try {
      await fetch(`${SERVER}/api/goals/${goalId}/steps/${stepId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
        body: JSON.stringify({ completed }),
      });
      if (completed) {
        const responses = [
          "Well done. The Stoics called this discipline — doing what you said you would do.",
          "One step closer. Marcus Aurelius: 'Confine yourself to the present.' You did that.",
          "Progress. Not luck, not accident — your effort.",
          "Done. This is what it looks like to assemble a life, action by action.",
          "Good. Seneca said the goal of life is to live. You're doing it.",
        ];
        Alert.alert('✓', responses[Math.floor(Math.random() * responses.length)], [{ text: 'Good' }]);
      }
    } catch {
      setGoals(prev => prev.map(g =>
        g.id === goalId ? { ...g, steps: g.steps.map(s => s.id === stepId ? { ...s, completed: !completed } : s) } : g
      ));
    }
  };

  const handleDeleteGoal = (goal: Goal) => {
    Alert.alert('Delete Goal', `Delete "${goal.title}" and all its steps?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: async () => {
          try {
            await fetch(`${SERVER}/api/goals/${goal.id}`, { method: 'DELETE', headers: { 'x-api-key': API_KEY } });
            setGoals(prev => prev.filter(g => g.id !== goal.id));
          } catch {
            Alert.alert('Error', 'Could not delete goal.');
          }
        },
      },
    ]);
  };

  const startNewGoal = () => {
    setShowConversation(true);
    setConversation([]);
    setGoalText('');
    setInput('');
    setPendingGoalTitle('');
    setConversationPhase('goal_input');
    setSavingGoal(false);
  };

  // ── Share a Winston response ───────────────────────────────────────────
  const handleShare = async (content: string) => {
    try {
      // First try the /api/goals/share endpoint for clean plain-text formatting
      const res = await fetch(`${SERVER}/api/goals/share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
        body: JSON.stringify({ content, format: 'plain', title: pendingGoalTitle }),
      });
      const data = await res.json();
      const text = data.ok ? data.text : content;
      await Share.share({ message: text, title: pendingGoalTitle || 'From Winston' });
    } catch {
      // Fallback: share raw markdown
      try {
        await Share.share({ message: content });
      } catch {
        Alert.alert('Share failed', 'Could not open the share sheet.');
      }
    }
  };

  // ── Send a message through the free-form /api/goals/chat endpoint ─────
  const callGoalsChat = async (messageText: string, history: ChatMessage[]) => {
    setIsThinking(true);
    try {
      const historyToSend = history.slice(0, -1); // last item is the user message we're about to send
      const res = await fetch(`${SERVER}/api/goals/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
        body: JSON.stringify({
          message: messageText,
          conversation_history: historyToSend,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const reply = data.response ?? "I didn't catch that — can you say more?";
      const assistantMsg: ChatMessage = { role: 'assistant', content: reply };
      setConversation(prev => [...prev, assistantMsg]);
      setConversationPhase('conversation');
      scrollToBottom();
    } catch {
      const errMsg: ChatMessage = {
        role: 'assistant',
        content: "I'm having trouble connecting right now. Try again in a moment.",
      };
      setConversation(prev => [...prev, errMsg]);
      setConversationPhase('conversation');
    } finally {
      setIsThinking(false);
      scrollToBottom();
    }
  };

  // User submits initial goal text
  const handleSendGoal = async () => {
    const text = goalText.trim();
    if (!text) return;
    setPendingGoalTitle(text);
    const userMsg: ChatMessage = { role: 'user', content: text };
    const newConversation = [userMsg];
    setConversation(newConversation);
    setGoalText('');
    setConversationPhase('conversation');
    await callGoalsChat(text, newConversation);
  };

  // User sends a follow-up message
  const handleSendMessage = async () => {
    const text = input.trim();
    if (!text || isThinking) return;
    const userMsg: ChatMessage = { role: 'user', content: text };
    const newConversation = [...conversation, userMsg];
    setConversation(newConversation);
    setInput('');
    scrollToBottom();
    await callGoalsChat(text, newConversation);
  };

  // Save goal + extracted steps via the breakdown endpoint (user explicitly asks)
  const handleSaveAsGoal = async () => {
    if (!pendingGoalTitle) return;
    setSavingGoal(true);
    try {
      // Ask the breakdown endpoint to produce structured steps from the conversation
      const res = await fetch(`${SERVER}/api/goals/breakdown`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
        body: JSON.stringify({
          goal: pendingGoalTitle,
          conversation_history: conversation,
          auto_save: true,
          goal_title: pendingGoalTitle,
        }),
      });
      const data = await res.json();

      if (data.goalId) {
        await fetchGoals();
        const savedMsg: ChatMessage = {
          role: 'assistant',
          content: data.steps?.length
            ? `Done — I've saved "${pendingGoalTitle}" with ${data.steps.length} steps. You can track your progress from the Goals list.`
            : `"${pendingGoalTitle}" is saved to your Goals list.`,
        };
        setConversation(prev => [...prev, savedMsg]);
        scrollToBottom();
      } else {
        Alert.alert('Could not save', 'Winston couldn\'t extract steps yet. Try asking "Give me a step-by-step plan" first.');
      }
    } catch {
      Alert.alert('Error', 'Could not save goal. Please try again.');
    } finally {
      setSavingGoal(false);
    }
  };

  // ── Conversation View ──────────────────────────────────────────────────
  if (showConversation) {
    const isGoalInput = conversationPhase === 'goal_input';
    const hasConversation = conversation.length > 0;

    return (
      <SafeAreaView style={styles.safe}>
        <StatusBar barStyle="light-content" backgroundColor={COLORS.background} />

        <View style={styles.header}>
          <TouchableOpacity
            onPress={() => {
              if (hasConversation) {
                Alert.alert('Leave this conversation?', 'Your conversation will be lost.', [
                  { text: 'Stay', style: 'cancel' },
                  { text: 'Leave', style: 'destructive', onPress: () => setShowConversation(false) },
                ]);
              } else {
                setShowConversation(false);
              }
            }}
            style={styles.headerBtn}
          >
            <Ionicons name="arrow-back" size={22} color={COLORS.gold} />
          </TouchableOpacity>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {pendingGoalTitle || 'New Goal'}
          </Text>
          {/* Save as Goal button — shown once we have a conversation */}
          {hasConversation ? (
            <TouchableOpacity
              onPress={handleSaveAsGoal}
              disabled={savingGoal}
              style={styles.headerBtn}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              {savingGoal
                ? <ActivityIndicator size="small" color={COLORS.gold} />
                : <Ionicons name="bookmark-outline" size={22} color={COLORS.gold} />
              }
            </TouchableOpacity>
          ) : (
            <View style={{ width: 34 }} />
          )}
        </View>
        <View style={styles.divider} />

        {isGoalInput && !hasConversation ? (
          // Initial goal input screen
          <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
            <View style={styles.goalInputContainer}>
              <Text style={styles.goalPrompt}>What do you want to achieve?</Text>
              <Text style={styles.goalPromptSub}>
                Be as specific or as broad as you like. Winston will help you understand it and guide you through it.
              </Text>
              <TextInput
                style={styles.goalInput}
                value={goalText}
                onChangeText={setGoalText}
                placeholder="e.g. Learn more about Jazz, Get in better shape, Write a book..."
                placeholderTextColor={COLORS.muted}
                multiline
                autoFocus
              />
              <TouchableOpacity
                style={[styles.startBtn, !goalText.trim() && styles.startBtnDisabled]}
                onPress={handleSendGoal}
                disabled={!goalText.trim()}
              >
                <Text style={styles.startBtnText}>Let's figure this out</Text>
                <Ionicons name="arrow-forward" size={18} color={COLORS.background} />
              </TouchableOpacity>
            </View>
          </KeyboardAvoidingView>
        ) : (
          // Conversation
          <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
            <ScrollView
              ref={scrollRef}
              style={styles.conversationScroll}
              contentContainerStyle={styles.conversationContent}
              showsVerticalScrollIndicator={false}
            >
              {conversation.map((msg, index) => (
                <ChatBubble
                  key={index}
                  msg={msg}
                  onShare={
                    msg.role === 'assistant'
                      ? () => handleShare(msg.content)
                      : undefined
                  }
                />
              ))}

              {isThinking && (
                <View style={[styles.chatBubbleAssistant, styles.chatBubble]}>
                  <Text style={styles.chatLabel}>Winston</Text>
                  <ActivityIndicator size="small" color={COLORS.gold} style={{ alignSelf: 'flex-start' }} />
                </View>
              )}
            </ScrollView>

            {/* Input bar — always visible during conversation */}
            <View style={styles.conversationInputBar}>
              <TextInput
                ref={inputRef}
                style={styles.conversationInput}
                value={input}
                onChangeText={setInput}
                placeholder="Reply to Winston..."
                placeholderTextColor={COLORS.muted}
                multiline
                onSubmitEditing={handleSendMessage}
                editable={!isThinking}
              />
              <TouchableOpacity
                style={[styles.sendBtn, (!input.trim() || isThinking) && styles.sendBtnDisabled]}
                onPress={handleSendMessage}
                disabled={!input.trim() || isThinking}
              >
                {isThinking ? (
                  <ActivityIndicator size="small" color={COLORS.background} />
                ) : (
                  <Ionicons name="send" size={18} color={COLORS.background} />
                )}
              </TouchableOpacity>
            </View>
          </KeyboardAvoidingView>
        )}
      </SafeAreaView>
    );
  }

  // ── Goals List View ────────────────────────────────────────────────────
  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" backgroundColor={COLORS.background} />

      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn}>
          <Ionicons name="arrow-back" size={22} color={COLORS.gold} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>My Goals</Text>
        <TouchableOpacity onPress={startNewGoal} style={styles.headerBtn}>
          <Ionicons name="add" size={24} color={COLORS.gold} />
        </TouchableOpacity>
      </View>
      <View style={styles.divider} />

      {isLoading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={COLORS.gold} />
        </View>
      ) : goals.length === 0 ? (
        <View style={styles.centered}>
          <Ionicons name="compass-outline" size={52} color={COLORS.muted} />
          <Text style={styles.emptyTitle}>No Goals Yet</Text>
          <Text style={styles.emptySubtitle}>
            Tell Winston what you want to achieve. It will help you understand it and build a real plan.
          </Text>
          <TouchableOpacity style={styles.addButton} onPress={startNewGoal}>
            <Text style={styles.addButtonText}>Set Your First Goal</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={goals}
          keyExtractor={g => g.id}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => (
            <GoalCard
              goal={item}
              expanded={expandedId === item.id}
              onExpand={() => setExpandedId(expandedId === item.id ? null : item.id)}
              onToggleStep={(stepId, completed) => handleToggleStep(item.id, stepId, completed)}
              onDelete={() => handleDeleteGoal(item)}
            />
          )}
          ListFooterComponent={
            <TouchableOpacity style={styles.addMoreBtn} onPress={startNewGoal}>
              <Ionicons name="add-circle-outline" size={20} color={COLORS.gold} />
              <Text style={styles.addMoreBtnText}>Add Another Goal</Text>
            </TouchableOpacity>
          }
        />
      )}
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.background },
  flex: { flex: 1 },
  divider: { height: 1, backgroundColor: COLORS.border },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },

  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 12, paddingTop: 50 },
  headerBtn: { padding: 6, width: 34 },
  headerTitle: { flex: 1, color: COLORS.cream, fontSize: 18, fontWeight: '600', textAlign: 'center', marginHorizontal: 8 },

  listContent: { padding: 16, gap: 12 },

  goalCard: { backgroundColor: COLORS.surface, borderRadius: 14, borderWidth: 1, borderColor: COLORS.border, overflow: 'hidden' },
  goalHeader: { flexDirection: 'row', alignItems: 'flex-start', padding: 16, gap: 12 },
  goalTitle: { color: COLORS.cream, fontSize: 16, fontWeight: '600', marginBottom: 4 },
  goalProgress: { color: COLORS.muted, fontSize: 12 },
  goalHeaderRight: { flexDirection: 'row', alignItems: 'center', gap: 12 },

  progressTrack: { height: 3, backgroundColor: COLORS.border, marginHorizontal: 16, marginBottom: 4, borderRadius: 2 },
  progressFill: { height: 3, backgroundColor: COLORS.green, borderRadius: 2 },

  stepsList: { borderTopWidth: 1, borderTopColor: COLORS.border, paddingHorizontal: 16, paddingVertical: 8 },
  stepRow: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 10, gap: 12 },
  stepText: { flex: 1, color: COLORS.cream, fontSize: 14, lineHeight: 20 },
  stepTextDone: { color: COLORS.muted, textDecorationLine: 'line-through' },
  stepDivider: { height: 1, backgroundColor: COLORS.border },
  noStepsText: { color: COLORS.muted, fontSize: 13, padding: 16, fontStyle: 'italic' },

  emptyTitle: { color: COLORS.cream, fontSize: 18, fontWeight: '600', marginTop: 16, marginBottom: 8 },
  emptySubtitle: { color: COLORS.muted, fontSize: 14, textAlign: 'center', lineHeight: 20, marginBottom: 24 },
  addButton: { backgroundColor: COLORS.gold, borderRadius: 24, paddingHorizontal: 28, paddingVertical: 12 },
  addButtonText: { color: COLORS.background, fontWeight: '700', fontSize: 15 },
  addMoreBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 20 },
  addMoreBtnText: { color: COLORS.gold, fontSize: 14, fontWeight: '500' },

  // Goal input
  goalInputContainer: { flex: 1, padding: 24, justifyContent: 'center' },
  goalPrompt: { color: COLORS.cream, fontSize: 24, fontWeight: '700', marginBottom: 8, lineHeight: 30 },
  goalPromptSub: { color: COLORS.muted, fontSize: 14, lineHeight: 20, marginBottom: 24 },
  goalInput: { backgroundColor: COLORS.surface, borderWidth: 1, borderColor: COLORS.border, borderRadius: 14, padding: 16, color: COLORS.cream, fontSize: 16, lineHeight: 24, minHeight: 100, textAlignVertical: 'top', marginBottom: 20 },
  startBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: COLORS.gold, borderRadius: 14, padding: 16 },
  startBtnDisabled: { backgroundColor: COLORS.border },
  startBtnText: { color: COLORS.background, fontSize: 16, fontWeight: '700' },

  // Conversation
  conversationScroll: { flex: 1 },
  conversationContent: { padding: 16, gap: 12, paddingBottom: 24 },

  chatBubble: { maxWidth: '90%', borderRadius: 14, padding: 14 },
  chatBubbleUser: { alignSelf: 'flex-end', backgroundColor: '#1E2A4A', borderWidth: 1, borderColor: '#2A3A5E' },
  chatBubbleAssistant: { alignSelf: 'flex-start', backgroundColor: COLORS.surface, borderWidth: 1, borderColor: COLORS.border },
  chatBubbleTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  chatLabel: { color: COLORS.gold, fontSize: 10, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase' },
  chatTextUser: { color: COLORS.cream, fontSize: 15, lineHeight: 22 },

  // Input bar
  conversationInputBar: { flexDirection: 'row', alignItems: 'flex-end', paddingHorizontal: 16, paddingVertical: 12, paddingBottom: 24, backgroundColor: COLORS.surface, borderTopWidth: 1, borderTopColor: COLORS.border, gap: 10 },
  conversationInput: { flex: 1, backgroundColor: COLORS.surfaceRaised, borderWidth: 1, borderColor: COLORS.border, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 10, color: COLORS.cream, fontSize: 15, maxHeight: 100 },
  sendBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: COLORS.gold, alignItems: 'center', justifyContent: 'center' },
  sendBtnDisabled: { backgroundColor: COLORS.border },
});
