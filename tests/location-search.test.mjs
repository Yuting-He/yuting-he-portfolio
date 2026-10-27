import test from 'node:test';
import assert from 'node:assert/strict';
import { searchLocations } from '../heatwave-controls.js';
const locations = [
  { id:'DE212', name:'München, Kreisfreie Stadt', stateName:'Bayern' },
  { id:'DE21H', name:'München, Landkreis', stateName:'Bayern' },
  { id:'DE2', name:'Bayern', stateName:'Bayern' },
  { id:'DEA23', name:'Köln, Kreisfreie Stadt', stateName:'Nordrhein-Westfalen' }
];
test('location search handles umlauts, transliterations, English aliases and ambiguous districts', () => {
  for (const query of ['München','munchen','Muenchen','Munich']) assert.equal(searchLocations(locations,query).length,2);
  assert.equal(searchLocations(locations,'Cologne')[0].id,'DEA23');
  assert.equal(searchLocations(locations,'DE21H')[0].name,'München, Landkreis');
  assert.equal(searchLocations(locations,'Bayern')[0].id,'DE2');
  assert.deepEqual(searchLocations(locations,''),[]);
  assert.deepEqual(searchLocations(locations,'not-a-place'),[]);
  assert.equal(searchLocations(locations,'Bayern',1).length,1);
});
