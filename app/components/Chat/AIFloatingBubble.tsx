'use client';

import styles from './AIFloatingBubble.module.css';

interface AIFloatingBubbleProps {
  open: boolean;
  onToggle: () => void;
  title?: string;
  position?: 'bottom-right' | 'top-right';
}

export default function AIFloatingBubble({ open, onToggle, title = 'AI 對話助手', position = 'bottom-right' }: AIFloatingBubbleProps) {
  return (
    <button
      className={`${styles.bubble}${position === 'top-right' ? ' ' + styles.topRight : ''}${open ? ' ' + styles.bubbleOpen : ''}`}
      onClick={onToggle}
      title={title}
      aria-label={title}
    >
      <img className={styles.bubbleIcon} src="/kingdom-ai-icon.png" alt="国度AI解答" />
    </button>
  );
}
