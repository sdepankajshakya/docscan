import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: 'home',
    loadComponent: () => import('./home/home.page').then((m) => m.HomePage),
  },
  {
    path: 'editor',
    loadComponent: () => import('./components/doc-editor/doc-editor.component').then(m => m.DocEditorComponent)
  },
  {
    path: 'edge-adjust',
    loadComponent: () => import('./components/edge-adjust/edge-adjust.component').then(m => m.EdgeAdjustComponent)
  },
  {
    path: '',
    redirectTo: 'home',
    pathMatch: 'full',
  },
];
