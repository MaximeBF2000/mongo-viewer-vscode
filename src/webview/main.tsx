import { render } from 'preact';
import './styles.css';
import { CollectionApp } from './CollectionApp';
import { ConnectionForm } from './ConnectionForm';
import { PlaygroundResults } from './PlaygroundResults';

const root = document.getElementById('app')!;
const view = root.dataset.view;

render(view === 'connectionForm' ? <ConnectionForm /> : view === 'playground' ? <PlaygroundResults /> : <CollectionApp />, root);
