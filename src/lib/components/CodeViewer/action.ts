import { Operation, type Delta } from '$lib/deltas';
import { Text, ChangeSet, EditorState, EditorSelection, type ChangeSpec } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { getLanguage } from './languages';
import extensions from './extensions';

const toChangeSpec = (operation: Operation): ChangeSpec => {
    if (Operation.isInsert(operation)) {
        return {
            from: operation.insert[0],
            insert: operation.insert[1]
        };
    } else if (Operation.isDelete(operation)) {
        return {
            from: operation.delete[0],
            to: operation.delete[0] + operation.delete[1]
        };
    } else {
        throw new Error(`${operation} is not supported`);
    }
};

type Params = { doc: string; deltas: Delta[]; filepath: string };

const makeBaseState = (doc: string, filepath: string) => {
    const language = getLanguage(filepath);
    return EditorState.create({
        doc,
        extensions: language ? [...extensions, language] : extensions
    });
};

const toChangeSet = (deltas: Delta[], initLength: number): ChangeSet => {
    const specs = deltas.flatMap(({ operations }) => operations.map(toChangeSpec));
    const sets = specs.reduce((sets: ChangeSet[], spec) => {
        const set = ChangeSet.of(spec, sets.length > 0 ? sets[sets.length - 1].newLength : initLength);
        return [...sets, set];
    }, [] as ChangeSet[]);
    return sets.length > 0 ? sets.reduce((a, b) => a.compose(b)) : ChangeSet.empty(initLength);
};

const selection = (changes: ChangeSet, delta: Delta | undefined): EditorSelection | undefined => {
    if (delta === undefined) return undefined;
    if (delta.operations.length === 0) return undefined;
    const lastDelta = delta.operations[delta.operations.length - 1];
    if (Operation.isInsert(lastDelta)) {
        const anchor = lastDelta.insert[0];
        const head = lastDelta.insert[0] + lastDelta.insert[1].length;
        if (changes.newLength < anchor) return undefined;
        if (changes.newLength < head) return undefined;
        return EditorSelection.single(anchor, head);
    } else if (Operation.isDelete(lastDelta)) {
        const anchor = lastDelta.delete[0];
        const head = lastDelta.delete[0] + lastDelta.delete[1];
        if (changes.newLength < anchor) return undefined;
        if (changes.newLength < head) return undefined;
        return EditorSelection.single(anchor, head);
    } else {
        return undefined;
    }
};

// this action assumes:
// * that deltas list is append only.
// * that each (filepath, doc) pair never changes.
export default (parent: HTMLElement, { doc, deltas, filepath }: Params) => {
    const view = new EditorView({ state: makeBaseState(doc, filepath), parent });

    view.dispatch(
        view.state.update({
            changes: toChangeSet(deltas, doc.length)
        })
    );

    let currentFilepath = filepath;
    const stateCache: Record<string, EditorState> = {};
    const deltasCache: Record<string, Delta[]> = {};

    stateCache[filepath] = view.state;
    deltasCache[filepath] = deltas;

    return {
        update: ({ doc, deltas: newDeltas, filepath }: Params) => {
            if (filepath !== currentFilepath) {
                view.setState(stateCache[filepath] ?? makeBaseState(doc, filepath));
            }

            const currentDeltas = deltasCache[filepath] || [];
            if (currentDeltas.length > newDeltas.length) {
                // rewind backward
                const baseText = Text.of([doc]);
                const targetChange = toChangeSet(newDeltas, baseText.length);
                const targetText = targetChange.apply(baseText);

                const deltasToRevert = currentDeltas.slice(newDeltas.length);
                const revertChange = toChangeSet(deltasToRevert, targetText.length);
                const changes = revertChange.invert(targetText);

                view.dispatch({
                    changes: changes,
                    selection: selection(changes, deltasToRevert.at(0)),
                    scrollIntoView: true
                });
            } else {
                // rewind forward

                // verify that deltas are append only
                currentDeltas.forEach((delta, i) => {
                    if (i >= newDeltas.length) return;
                    if (delta !== newDeltas[i]) throw new Error('deltas are not append only');
                });

                const deltasToApply = newDeltas.slice(currentDeltas.length);
                const changes = toChangeSet(deltasToApply, view.state.doc.length);

                view.dispatch({
                    changes,
                    selection: selection(changes, deltasToApply.at(-1)),
                    scrollIntoView: true
                });
            }

            // don't forget to update caches
            stateCache[filepath] = view.state;
            deltasCache[filepath] = newDeltas;
            currentFilepath = filepath;
        },
        destroy: () => view.destroy()
    };
};
