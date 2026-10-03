import { createContext, useContext } from 'react';

/**
 * True inside the Fluke assistant's chat: turns get an author header, user
 * messages render as bubbles and coding-agent noise (scripts, raw reasoning)
 * is hidden. The task chat keeps the default presentation.
 */
export const AssistantChatContext = createContext(false);

export const useIsAssistantChat = () => useContext(AssistantChatContext);
