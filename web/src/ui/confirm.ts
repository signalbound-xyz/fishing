/**
 * A question before something that cannot be taken back (spending PEARL, for one). A native modal dialog:
 * the browser keeps the focus inside it, closes it on Escape and puts the page behind it out of reach.
 */
import { h } from './dom';

export interface ConfirmOptions {
  title: string;
  /** What will happen, row by row: a name and its value. */
  rows?: [string, string][];
  note?: string;
  /** The button that goes ahead. */
  confirm: string;
  cancel?: string;
}

/** Resolves to true only when the player presses the confirm button. */
export function confirmDialog(o: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    let answer = false;
    const dialog: HTMLDialogElement = h(
      'dialog',
      { class: 'confirm', attrs: { 'aria-label': o.title } },
      h('div', { class: 'confirm-title', text: o.title }),
      o.rows?.length ? h('dl', { class: 'confirm-rows' }, ...o.rows.map(([k, v]) => h('div', null, h('dt', { text: k }), h('dd', { text: v })))) : null,
      o.note ? h('p', { class: 'confirm-note', text: o.note }) : null,
    );
    const close = (yes: boolean): void => {
      answer = yes;
      dialog.close();
    };
    // "Cancel" holds the focus: a key still held from the click that opened the dialog must not confirm it
    const cancel = h('button', { class: 'btn', text: o.cancel ?? 'Cancel', attrs: { type: 'button', autofocus: '' }, onclick: () => close(false) });
    dialog.append(h('div', { class: 'confirm-actions' }, cancel, h('button', { class: 'btn btn-primary', text: o.confirm, attrs: { type: 'button' }, onclick: () => close(true) })));
    // a click on the dimmed page around the box is a "no"
    dialog.addEventListener('click', (e) => {
      const box = dialog.getBoundingClientRect();
      const inside = e.clientX >= box.left && e.clientX <= box.right && e.clientY >= box.top && e.clientY <= box.bottom;
      if (e.target === dialog && !inside) close(false);
    });
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(answer);
    });
    document.body.append(dialog);
    dialog.showModal();
  });
}
