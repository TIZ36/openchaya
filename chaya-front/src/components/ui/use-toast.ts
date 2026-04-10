import * as React from 'react';

const TOAST_LIMIT = 3;
const TOAST_REMOVE_DELAY = 1000000;

export type ToastVariant = 'default' | 'destructive' | 'success';

export type ToastProps = {
  id: string;
  title?: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  variant?: ToastVariant;
  duration?: number;
};

type ToastState = {
  toasts: ToastProps[];
};

type ToastAction =
  | { type: 'ADD_TOAST'; toast: ToastProps }
  | { type: 'UPDATE_TOAST'; toast: Partial<ToastProps> & { id: string } }
  | { type: 'DISMISS_TOAST'; toastId?: string }
  | { type: 'REMOVE_TOAST'; toastId?: string };

const toastTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

function addToRemoveQueue(toastId: string) {
  if (toastTimeouts.has(toastId)) return;
  const timeout = setTimeout(() => {
    toastTimeouts.delete(toastId);
    dispatch({ type: 'REMOVE_TOAST', toastId });
  }, TOAST_REMOVE_DELAY);
  toastTimeouts.set(toastId, timeout);
}

function reducer(state: ToastState, action: ToastAction): ToastState {
  switch (action.type) {
    case 'ADD_TOAST':
      return {
        ...state,
        toasts: [action.toast, ...state.toasts].slice(0, TOAST_LIMIT),
      };
    case 'UPDATE_TOAST':
      return {
        ...state,
        toasts: state.toasts.map((toast) =>
          toast.id === action.toast.id ? { ...toast, ...action.toast } : toast,
        ),
      };
    case 'DISMISS_TOAST': {
      const toastId = action.toastId;
      if (toastId) addToRemoveQueue(toastId);
      return {
        ...state,
        toasts: state.toasts.map((toast) =>
          toastId === undefined || toast.id === toastId
            ? { ...toast, duration: 0 }
            : toast,
        ),
      };
    }
    case 'REMOVE_TOAST':
      return {
        ...state,
        toasts: action.toastId
          ? state.toasts.filter((toast) => toast.id !== action.toastId)
          : [],
      };
    default:
      return state;
  }
}

const listeners: Array<(state: ToastState) => void> = [];
let memoryState: ToastState = { toasts: [] };

function dispatch(action: ToastAction) {
  memoryState = reducer(memoryState, action);
  listeners.forEach((listener) => listener(memoryState));
}

function genId() {
  return Math.random().toString(36).slice(2);
}

export function toast(props: Omit<ToastProps, 'id'>) {
  const id = genId();
  dispatch({ type: 'ADD_TOAST', toast: { id, ...props } });
  return {
    id,
    dismiss: () => dispatch({ type: 'DISMISS_TOAST', toastId: id }),
    update: (partial: Partial<ToastProps>) =>
      dispatch({ type: 'UPDATE_TOAST', toast: { id, ...partial } }),
  };
}

export function useToast() {
  const [state, setState] = React.useState<ToastState>(memoryState);

  React.useEffect(() => {
    listeners.push(setState);
    return () => {
      const index = listeners.indexOf(setState);
      if (index > -1) listeners.splice(index, 1);
    };
  }, []);

  return {
    ...state,
    toast,
    dismiss: (toastId?: string) =>
      dispatch({ type: 'DISMISS_TOAST', toastId }),
  };
}

