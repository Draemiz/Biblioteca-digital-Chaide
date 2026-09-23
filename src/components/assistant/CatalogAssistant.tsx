import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, BookOpen, Bot, Loader2, MessageCircle, RefreshCw, Send, ShieldCheck, SpellCheck, Trash2, X } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  answerCatalogQuestion,
  pruneCatalogAssistantCache,
  type CatalogAssistantSource,
} from '../../lib/catalogAssistant';
import type { CatalogSpellingCorrection } from '../../lib/catalogAssistantSpelling';
import { contextualizeCatalogQuestion } from '../../lib/catalogAssistantSpelling';
import { filterCurrentAssistantSources } from '../../lib/catalogAssistantFreshness';
import { requestGroundedCatalogAnswer } from '../../lib/catalogAssistantRemote';
import { createCatalogViewerHref } from '../../lib/catalogViewerLink';
import { isFirebaseSite } from '../../lib/runtimeConfig';
import { useStore } from '../../store/useStore';

type ChatMessage = {
  id: string;
  role: 'assistant' | 'user';
  text: string;
  sources?: CatalogAssistantSource[];
  query?: string;
  detail?: string;
  answerMode?: 'ai' | 'search';
  retryQuestion?: string;
  kind?: 'error' | 'notice';
  corrections?: CatalogSpellingCorrection[];
  contextUsed?: boolean;
};

const INITIAL_MESSAGE: ChatMessage = {
  id: 'welcome',
  role: 'assistant',
  text: 'Hola. Puedo buscar productos, medidas, materiales y características únicamente dentro de los catálogos de Chaide. Cada respuesta incluye la página exacta de donde salió.',
};

const SUGGESTIONS = [
  '¿Qué información hay del edredón Zafiro?',
  '¿Qué colchones tienen tecnología de enfriamiento?',
  'Busca medidas para hoteles',
];

export default function CatalogAssistant() {
  const documents = useStore((state) => state.documents);
  const fetchDocuments = useStore((state) => state.fetchDocuments);
  const hasLoadedDocs = useStore((state) => state.hasLoadedDocs);
  const role = useStore((state) => state.role);
  const syncDocuments = useStore((state) => state.syncDocuments);
  const documentsSyncStatus = useStore((state) => state.documentsSyncStatus);
  const location = useLocation();
  const navigate = useNavigate();
  const [isOpen, setIsOpen] = useState(false);
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([INITIAL_MESSAGE]);
  const [isThinking, setIsThinking] = useState(false);
  const [progress, setProgress] = useState('');
  const [sourceOpening, setSourceOpening] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const conversationContextRef = useRef<{ question: string; catalogId: string } | null>(null);

  const currentCatalogId = useMemo(() => {
    const match = location.pathname.match(/^\/viewer\/([^/]+)/);
    return match ? decodeURIComponent(match[1]) : undefined;
  }, [location.pathname]);

  useEffect(() => {
    if (isOpen && !hasLoadedDocs) void fetchDocuments();
  }, [fetchDocuments, hasLoadedDocs, isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [isOpen]);

  useEffect(() => {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    messagesRef.current?.scrollTo({
      top: messagesRef.current.scrollHeight,
      behavior: reduceMotion ? 'auto' : 'smooth',
    });
  }, [messages, isThinking, progress]);

  useEffect(() => {
    if (!isOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [isOpen]);

  const getFreshDocuments = async () => {
    if (isFirebaseSite) {
      const { fetchFirebaseDocuments } = await import('../../lib/firebaseCatalog');
      const freshDocuments = await fetchFirebaseDocuments(role === 'admin');
      syncDocuments(freshDocuments);
      pruneCatalogAssistantCache(freshDocuments);
      return freshDocuments;
    }
    if (!useStore.getState().hasLoadedDocs) await fetchDocuments(role === 'admin');
    const currentDocuments = useStore.getState().documents;
    pruneCatalogAssistantCache(currentDocuments);
    return currentDocuments.length ? currentDocuments : documents;
  };

  const submitQuestion = async (rawQuestion: string) => {
    const question = rawQuestion.trim();
    if (!question || isThinking) return;
    setInput('');
    setMessages((previous) => [...previous, {
      id: crypto.randomUUID(),
      role: 'user',
      text: question,
    }]);
    setIsThinking(true);
    setProgress('Consultando los índices de los catálogos…');

    try {
      const availableDocuments = await getFreshDocuments();
      const contextualQuestion = contextualizeCatalogQuestion(
        question,
        conversationContextRef.current?.question,
      );
      const scopedDocuments = contextualQuestion.usedContext && conversationContextRef.current
        ? availableDocuments.filter((document) => document.id === conversationContextRef.current?.catalogId)
        : availableDocuments;
      let answer = await answerCatalogQuestion(
        contextualQuestion.question,
        scopedDocuments,
        contextualQuestion.usedContext
          ? conversationContextRef.current?.catalogId
          : currentCatalogId,
        (completed, total) => setProgress(`Revisando catálogos ${completed}/${total}…`),
      );

      // Re-read Firestore after retrieval. If a catalogue was replaced or
      // deleted while the search was running, discard every stale source and
      // run the search once more against the newest version.
      if (isFirebaseSite && answer.sources.length > 0) {
        setProgress('Confirmando que las fuentes siguen publicadas…');
        const latestDocuments = await getFreshDocuments();
        const currentSources = filterCurrentAssistantSources(answer.sources, latestDocuments);
        if (currentSources.length !== answer.sources.length) {
          setProgress('El catálogo cambió; actualizando la respuesta…');
          const latestScopedDocuments = contextualQuestion.usedContext && conversationContextRef.current
            ? latestDocuments.filter((document) => document.id === conversationContextRef.current?.catalogId)
            : latestDocuments;
          answer = await answerCatalogQuestion(
            contextualQuestion.question,
            latestScopedDocuments,
            contextualQuestion.usedContext
              ? conversationContextRef.current?.catalogId
              : currentCatalogId,
          );
        } else {
          answer = { ...answer, sources: currentSources };
        }
      }
      setProgress(answer.sources.length > 0
        ? 'Preparando una respuesta basada en las fuentes…'
        : 'Terminando la consulta…');
      const generatedAnswer = answer.sources.length > 0
        ? await requestGroundedCatalogAnswer(answer.interpretedQuestion, answer.sources)
        : null;
      if (answer.sources.length > 0) {
        conversationContextRef.current = {
          question: answer.interpretedQuestion,
          catalogId: answer.sources[0].catalogId,
        };
      }
      setMessages((previous) => [...previous, {
        id: crypto.randomUUID(),
        role: 'assistant',
        text: generatedAnswer?.text || answer.text,
        sources: generatedAnswer?.sources || answer.sources,
        query: question,
        detail: answer.searchedPages
          ? `${generatedAnswer ? 'Respuesta IA verificada' : 'Resultado del buscador'} en ${answer.searchedPages} páginas de ${answer.searchedCatalogs} catálogos.`
          : undefined,
        answerMode: generatedAnswer ? 'ai' : 'search',
        corrections: answer.corrections,
        contextUsed: contextualQuestion.usedContext,
      }]);
    } catch (error) {
      console.warn('[Assistant] Catalogue query failed.', error);
      setMessages((previous) => [...previous, {
        id: crypto.randomUUID(),
        role: 'assistant',
        text: 'No pude confirmar los catálogos publicados en este momento. No mostraré información que pueda estar desactualizada.',
        retryQuestion: question,
        kind: 'error',
      }]);
    } finally {
      setIsThinking(false);
      setProgress('');
    }
  };

  const openSource = async (source: CatalogAssistantSource, query: string) => {
    const sourceKey = `${source.catalogId}:${source.indexVersion}:${source.pageNumber}`;
    if (sourceOpening) return;
    setSourceOpening(sourceKey);
    try {
      const freshDocuments = await getFreshDocuments();
      if (filterCurrentAssistantSources([source], freshDocuments).length !== 1) {
        setMessages((previous) => [...previous, {
          id: crypto.randomUUID(),
          role: 'assistant',
          text: 'Esa fuente fue reemplazada o retirada. Ya eliminé la referencia anterior; vuelve a realizar la consulta para obtener información vigente.',
          retryQuestion: query,
          kind: 'notice',
        }]);
        return;
      }
      setIsOpen(false);
      navigate(createCatalogViewerHref({
        catalogId: source.catalogId,
        pageNumber: source.pageNumber,
        search: source.searchTerm || query,
      }));
    } finally {
      setSourceOpening('');
    }
  };

  return (
    <aside className="catalog-assistant" aria-label="Asistente de catálogos">
      {isOpen && (
        <section
          className="catalog-assistant-panel"
          role="dialog"
          aria-modal="false"
          aria-labelledby="catalog-assistant-title"
        >
          <header className="catalog-assistant-header">
            <div className="catalog-assistant-brand">
              <span className="catalog-assistant-brand-icon"><Bot aria-hidden="true" /></span>
              <div>
                <h2 id="catalog-assistant-title">Asistente Chaide</h2>
                <p><span /> Responde desde los PDFs</p>
              </div>
            </div>
            <div className="catalog-assistant-header-actions">
              {messages.length > 1 && (
                <button
                  type="button"
                  className="catalog-assistant-icon-button"
                  onClick={() => {
                    conversationContextRef.current = null;
                    setMessages([INITIAL_MESSAGE]);
                  }}
                  aria-label="Borrar conversación"
                  title="Borrar conversación"
                >
                  <Trash2 aria-hidden="true" />
                </button>
              )}
              <button
                type="button"
                className="catalog-assistant-icon-button"
                onClick={() => setIsOpen(false)}
                aria-label="Cerrar asistente"
              >
                <X aria-hidden="true" />
              </button>
            </div>
          </header>

          <div className={`catalog-assistant-trust is-${documentsSyncStatus}`} role="status">
            <ShieldCheck aria-hidden="true" />
            <span>
              {documentsSyncStatus === 'syncing' && 'Sincronizando el conocimiento publicado…'}
              {documentsSyncStatus === 'live' && 'Conocimiento actualizado automáticamente desde los PDFs publicados.'}
              {documentsSyncStatus === 'error' && 'Cada consulta se verificará antes de responder.'}
              {documentsSyncStatus === 'idle' && 'Solo usa el texto indexado de los catálogos publicados.'}
            </span>
          </div>

          <div
            className="catalog-assistant-messages"
            ref={messagesRef}
            aria-live="polite"
            aria-busy={isThinking}
          >
            {messages.map((message) => (
              <article
                key={message.id}
                className={`catalog-assistant-message is-${message.role}${message.kind ? ` is-${message.kind}` : ''}`}
              >
                <div className="catalog-assistant-bubble">{message.text}</div>
                {message.corrections && message.corrections.length > 0 && (
                  <div className="catalog-assistant-correction" role="status">
                    <SpellCheck aria-hidden="true" />
                    <span>
                      Interpreté {message.corrections.map((correction, index) => (
                        <React.Fragment key={`${correction.from}-${correction.to}`}>
                          {index > 0 && ', '}
                          <s>{correction.from}</s> como <strong>{correction.to}</strong>
                        </React.Fragment>
                      ))}.
                    </span>
                  </div>
                )}
                {message.contextUsed && (
                  <div className="catalog-assistant-context-note">
                    Continué con el producto de la pregunta anterior.
                  </div>
                )}
                {message.sources && message.sources.length > 0 && (
                  <div className="catalog-assistant-sources">
                    <p>Fuentes encontradas</p>
                    {message.sources.map((source) => (
                      <button
                        type="button"
                        key={`${source.catalogId}-${source.pageNumber}`}
                        onClick={() => void openSource(source, message.query || '')}
                        className="catalog-assistant-source"
                        disabled={Boolean(sourceOpening)}
                      >
                        {sourceOpening === `${source.catalogId}:${source.indexVersion}:${source.pageNumber}`
                          ? <Loader2 className="catalog-assistant-spin" aria-hidden="true" />
                          : <BookOpen aria-hidden="true" />}
                        <span>
                          <strong>{source.title}</strong>
                          <small>Página {source.pageNumber} · Abrir en el visor</small>
                        </span>
                        <ArrowUpRight aria-hidden="true" />
                      </button>
                    ))}
                  </div>
                )}
                {message.detail && (
                  <small className={`catalog-assistant-detail${message.answerMode ? ` is-${message.answerMode}` : ''}`}>
                    {message.detail}
                  </small>
                )}
                {message.retryQuestion && (
                  <button
                    type="button"
                    className="catalog-assistant-retry"
                    onClick={() => void submitQuestion(message.retryQuestion || '')}
                    disabled={isThinking}
                  >
                    <RefreshCw aria-hidden="true" />
                    Consultar nuevamente
                  </button>
                )}
              </article>
            ))}

            {messages.length === 1 && (
              <div className="catalog-assistant-suggestions">
                {SUGGESTIONS.map((suggestion) => (
                  <button type="button" key={suggestion} onClick={() => void submitQuestion(suggestion)}>
                    {suggestion}
                  </button>
                ))}
              </div>
            )}

            {isThinking && (
              <div className="catalog-assistant-thinking">
                <Loader2 aria-hidden="true" />
                <span>{progress || 'Buscando en los catálogos…'}</span>
              </div>
            )}
          </div>

          <form
            className="catalog-assistant-form"
            onSubmit={(event) => {
              event.preventDefault();
              void submitQuestion(input);
            }}
          >
            <label htmlFor="catalog-assistant-input" className="sr-only">Pregunta sobre los catálogos</label>
            <input
              id="catalog-assistant-input"
              ref={inputRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="Pregunta por un producto o característica…"
              autoComplete="off"
              maxLength={600}
              disabled={isThinking}
              aria-describedby="catalog-assistant-help"
            />
            <button type="submit" disabled={!input.trim() || isThinking} aria-label="Enviar pregunta">
              <Send aria-hidden="true" />
            </button>
          </form>
          <p id="catalog-assistant-help" className="catalog-assistant-footnote">
            Las respuestas muestran siempre el catálogo, su versión vigente y la página de origen.
          </p>
        </section>
      )}

      <button
        type="button"
        className="catalog-assistant-trigger"
        onClick={() => setIsOpen((value) => !value)}
        aria-expanded={isOpen}
        aria-label={isOpen ? 'Cerrar asistente de catálogos' : 'Abrir asistente de catálogos'}
      >
        {isOpen ? <X aria-hidden="true" /> : <MessageCircle aria-hidden="true" />}
        {!isOpen && <span>Pregúntame</span>}
      </button>
    </aside>
  );
}
