"use client";

import { Card } from "./Card";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./RadixTooltip";
import { cn } from "../lib/cn";
import {
  DragDropContext,
  Droppable,
  Draggable,
  type DropResult,
  type DraggableProvided,
  type DraggableStateSnapshot,
  type DroppableProvided,
} from "@hello-pangea/dnd";
import {
  type KeyboardEvent,
  type MouseEvent,
  type MutableRefObject,
  type ReactNode,
  type Ref,
} from "react";
import { useTranslation } from "react-i18next";
import { DotsSixVerticalIcon, PlusIcon } from "@phosphor-icons/react";
import { Button } from "./Button";

export type { DropResult } from "@hello-pangea/dnd";

export type Status = {
  id: string;
  name: string;
  color: string;
};

export type Feature = {
  id: string;
  name: string;
  startAt: Date;
  endAt: Date;
  status: Status;
};

// =============================================================================
// Kanban Board (Droppable Column)
// =============================================================================

export type KanbanBoardProps = {
  children: ReactNode;
  className?: string;
};

export const KanbanBoard = ({ children, className }: KanbanBoardProps) => {
  return (
    <div className={cn("flex flex-col min-h-40", className)}>{children}</div>
  );
};

// =============================================================================
// Kanban Card (Draggable)
// =============================================================================

export type KanbanCardProps = Pick<Feature, "id" | "name"> & {
  index: number;
  children?: ReactNode;
  className?: string;
  onClick?: (e: MouseEvent<HTMLDivElement>) => void;
  tabIndex?: number;
  forwardedRef?: Ref<HTMLDivElement>;
  onKeyDown?: (e: KeyboardEvent) => void;
  isOpen?: boolean;
  isSelected?: boolean;
  dragDisabled?: boolean;
  isMobile?: boolean;
};

export const KanbanCard = ({
  id,
  name,
  index,
  children,
  className,
  onClick,
  tabIndex,
  forwardedRef,
  onKeyDown,
  isOpen,
  isSelected,
  dragDisabled = false,
  isMobile,
}: KanbanCardProps) => {
  return (
    <Draggable draggableId={id} index={index} isDragDisabled={dragDisabled}>
      {(provided: DraggableProvided, snapshot: DraggableStateSnapshot) => {
        // Combine DnD ref and forwarded ref
        const setRefs = (node: HTMLDivElement | null) => {
          provided.innerRef(node);
          if (typeof forwardedRef === "function") {
            forwardedRef(node);
          } else if (forwardedRef && typeof forwardedRef === "object") {
            (forwardedRef as MutableRefObject<HTMLDivElement | null>).current =
              node;
          }
        };

        return (
          <Card
            className={cn(
              "group/card p-3.5 outline-none flex-col border border-border/60 rounded-xl bg-primary shadow-soft transition-all duration-150",
              "hover:shadow-card hover:border-border hover:-translate-y-0.5",
              snapshot.isDragging && "cursor-grabbing shadow-card-hover",
              isSelected
                ? "ring-2 ring-brand ring-offset-1 ring-offset-background bg-brand/5"
                : isOpen &&
                    "ring-2 ring-brand/60 ring-offset-1 ring-offset-background",
              className,
            )}
            ref={setRefs}
            {...provided.draggableProps}
            {...(isMobile ? {} : provided.dragHandleProps)}
            tabIndex={tabIndex}
            onClick={
              isMobile
                ? (e) => {
                    if (!snapshot.isDragging) onClick?.(e);
                  }
                : undefined
            }
            onMouseUp={
              !isMobile
                ? (e) => {
                    if (e.button === 0 && !snapshot.isDragging) {
                      onClick?.(e);
                    }
                  }
                : undefined
            }
            onKeyDown={onKeyDown}
          >
            {isMobile ? (
              <div className="flex gap-half">
                <div
                  {...provided.dragHandleProps}
                  className="flex items-start pt-half cursor-grab shrink-0"
                  onClick={(e) => e.stopPropagation()}
                >
                  <DotsSixVerticalIcon
                    className="size-icon-xs text-low"
                    weight="bold"
                  />
                </div>
                <div className="flex-1 min-w-0">
                  {children ?? (
                    <p className="m-0 font-medium text-sm">{name}</p>
                  )}
                </div>
              </div>
            ) : (
              (children ?? <p className="m-0 font-medium text-sm">{name}</p>)
            )}
          </Card>
        );
      }}
    </Draggable>
  );
};

// =============================================================================
// Kanban Cards Container
// =============================================================================

export type KanbanCardsProps = {
  id: string;
  children: ReactNode;
  className?: string;
};

export const KanbanCards = ({ id, children, className }: KanbanCardsProps) => (
  <Droppable droppableId={id}>
    {(provided: DroppableProvided) => (
      <div
        className={cn(
          "flex flex-1 flex-col gap-2 p-2 bg-secondary/40 border border-border/60 rounded-2xl overflow-hidden",
          className,
        )}
        ref={provided.innerRef}
        {...provided.droppableProps}
      >
        {children}
        {provided.placeholder}
      </div>
    )}
  </Droppable>
);

// =============================================================================
// Kanban Header
// =============================================================================

export type KanbanHeaderProps =
  | {
      children: ReactNode;
    }
  | {
      name: Status["name"];
      color: Status["color"];
      className?: string;
      onAddTask?: () => void;
    };

export const KanbanHeader = (props: KanbanHeaderProps) => {
  const { t } = useTranslation("tasks");

  if ("children" in props) {
    return props.children;
  }

  return (
    <div
      className={cn(
        "sticky top-0 z-20 flex shrink-0 items-center gap-2 px-3 py-2.5",
        "bg-background/95 backdrop-blur-sm border-b border-border/60",
        props.className,
      )}
    >
      <span className="flex-1 flex items-center gap-2">
        <div
          className="h-2 w-2 rounded-full shrink-0"
          style={{ backgroundColor: `hsl(var(${props.color}))` }}
        />

        <p className="m-0 text-xs font-semibold text-high uppercase tracking-wide">
          {props.name}
        </p>
      </span>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              className="m-0 p-0 h-0 text-foreground/50 hover:text-foreground"
              onClick={props.onAddTask}
              aria-label={t("actions.addTask")}
            >
              <PlusIcon className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">{t("actions.addTask")}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
};

// =============================================================================
// Kanban Provider (DragDropContext)
// =============================================================================

export type KanbanProviderProps = {
  children: ReactNode;
  onDragEnd: (result: DropResult) => void;
  className?: string;
};

export const KanbanProvider = ({
  children,
  onDragEnd,
  className,
}: KanbanProviderProps) => {
  return (
    <DragDropContext onDragEnd={onDragEnd}>
      <div
        className={cn(
          "inline-grid grid-flow-col auto-cols-[minmax(240px,400px)] gap-3 p-3 items-stretch min-h-full",
          className,
        )}
      >
        {children}
      </div>
    </DragDropContext>
  );
};
