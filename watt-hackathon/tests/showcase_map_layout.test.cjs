/* Run with: node --test tests/showcase_map_layout.test.cjs */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'web/showcase.js'), 'utf8');
const helper = source.slice(source.indexOf('  function layoutMapLabels('), source.indexOf('  function renderMap('));
const layout = new Function(`${helper}\nreturn layoutMapLabels;`)();
const bounds = {x:58, y:91, width:752, height:346};
const intersect = (a,b,gap=0) => a.x < b.x+b.width+gap && a.x+a.width+gap > b.x && a.y < b.y+b.height+gap && a.y+a.height+gap > b.y;

function verify(markers, options = {}) {
  const frozen = JSON.stringify(markers), labels = layout(markers, {bounds, ...options});
  assert.equal(JSON.stringify(markers), frozen, 'layout must preserve recorded coordinates');
  assert.equal(labels.length, markers.length);
  for (const label of labels) {
    const marker = markers.find(m => m.id === label.id);
    assert.equal(label.anchorX, marker.x);
    assert.equal(label.anchorY, marker.y);
    assert.ok(label.x >= bounds.x && label.y >= bounds.y, `${label.id} exceeds top/left bounds`);
    assert.ok(label.x+label.width <= bounds.x+bounds.width && label.y+label.height <= bounds.y+bounds.height, `${label.id} exceeds bottom/right bounds`);
    assert.ok(label.leaderX >= label.x && label.leaderX <= label.x+label.width);
    assert.ok(label.leaderY >= label.y && label.leaderY <= label.y+label.height);
    assert.ok(label.leaderX === label.x || label.leaderX === label.x+label.width || label.leaderY === label.y || label.leaderY === label.y+label.height, 'leader must end on the badge edge');
    for (const other of labels) if (other.id !== label.id) assert.ok(!intersect(label,other), `${label.id} overlaps ${other.id}`);
    for (const obstacle of options.obstacles || []) assert.ok(!intersect(label,obstacle), `${label.id} covers a route annotation`);
    for (const anchor of markers) {
      const radius = anchor.radius || 8;
      assert.ok(!intersect(label,{x:anchor.x-radius,y:anchor.y-radius,width:radius*2,height:radius*2}), `${label.id} hides ${anchor.id}'s true position`);
    }
  }
  assert.deepEqual(layout([...markers].reverse(), {bounds, ...options}), labels, 'fleet input order must not affect layout');
  return labels;
}

test('coincident drones stay distinct and retain their real positions at every map edge', () => {
  for (const scale of [1, 2.4]) for (const [x,y] of [[372,307],[58,91],[810,91],[58,437],[810,437]]) {
    const markers = Array.from({length:5}, (_,i) => ({id:`Drone ${i+1}`, x,y, width:46*scale,height:25*scale,offset:13*scale,priority:2}));
    verify(markers, {gap:7*scale});
  }
});

test('target callout and five nearby drones fit together on narrow screens', () => {
  for (const scale of [1,2.4]) {
    const markers = Array.from({length:5}, (_,i) => ({id:`Drone ${i+1}`, x:372+i/10,y:307+i/10, width:46*scale,height:25*scale,offset:13*scale,priority:2}));
    markers.push({id:'target',x:372,y:307,width:145*scale,height:40*scale,radius:15,offset:22*scale,preferBelow:true,priority:0});
    verify(markers,{gap:7*scale});
  }
});

test('frozen replay fleet badges avoid callouts, route annotations and each other', () => {
  const data = JSON.parse(fs.readFileSync(path.join(root,'artifacts/showcase_data.json'),'utf8'));
  const all = data.geometry.flatMap(g=>g.coordinates);
  const west = Math.min(...all.map(p=>p[0])), east = Math.max(...all.map(p=>p[0]));
  const south = Math.min(...all.map(p=>p[1])), north = Math.max(...all.map(p=>p[1]));
  const cos = Math.cos((north+south)/2*Math.PI/180), size = Math.min(690/((east-west)*cos),350/(north-south));
  const project = p => [425+(p[0]-(east+west)/2)*cos*size,278-(p[1]-(north+south)/2)*size];
  for (const frame of data.frames) for (const scale of [1,2.4]) {
    const target = project(data.geometry.find(g=>g.asset_id===(frame.asset_id || data.metadata.asset_id)).position);
    const markers = frame.fleet.map(d=>{const [x,y]=project(d.position);return {id:d.sensor_id,x,y,width:46*scale,height:25*scale,offset:13*scale,priority:d.sensor_id===frame.operation?.sensor_id?1:2};});
    markers.push({id:'target',x:target[0],y:target[1],width:145*scale,height:40*scale,radius:15,offset:22*scale,preferBelow:true,priority:0});
    const obstacles = [];
    if (frame.route) {
      const start=project(frame.route.coordinates[0]), end=project(frame.route.coordinates.at(-1));
      obstacles.push({x:Math.min(660,Math.max(58,start[0]+12)),y:Math.max(91,start[1]-27),width:150,height:18});
      obstacles.push({x:(start[0]+end[0])/2-39,y:(start[1]+end[1])/2-12,width:78,height:23});
    }
    verify(markers,{obstacles,gap:7*scale});
  }
});

function bootReplay(data) {
  const elements=new Map();
  const element=id=>{
    if(!elements.has(id))elements.set(id,{id,textContent:'',innerHTML:'',dataset:{},style:{setProperty(){}},classList:{add(){},toggle(){}},attributes:{},handlers:{},setAttribute(name,value){this.attributes[name]=value;},removeAttribute(name){delete this.attributes[name];},addEventListener(name,handler){this.handlers[name]=handler;},getBoundingClientRect(){return{width:850,height:540};},querySelectorAll(){return[];}});
    return elements.get(id);
  };
  element('showcase-data').textContent=JSON.stringify(data);
  const evidenceButtons=['operations','baseline','network','weather','audit'].map(name=>Object.assign(element(`tab-${name}`),{dataset:{evidence:name}}));
  const document={getElementById:element,body:element('body'),hidden:false,querySelector:()=>element('brand'),querySelectorAll:selector=>selector==='[data-evidence]'?evidenceButtons:[],addEventListener(){}};
  const window={matchMedia:()=>({matches:true}),history:{replaceState(){}},addEventListener(){}};
  vm.runInNewContext(source,{document,window,location:{hash:''},performance:{now:()=>0},requestAnimationFrame(){},console});
  assert.ok(window.GridScout,element('load-notice').innerHTML);
  return {window,element,evidenceButtons};
}

test('same-minute snapshots keep map, story and dashboard bound to the selected asset', () => {
  const data = JSON.parse(fs.readFileSync(path.join(root,'artifacts/showcase_data.json'),'utf8'));
  const nearby = structuredClone(data.frames.find(f=>f.asset_id==='LINE_058' && f.minute===51));
  assert.ok(nearby);
  nearby.minute=82; nearby.snapshot_id='test:LINE_058:82';
  const remote=structuredClone(nearby), position=asset=>data.geometry.find(g=>g.asset_id===asset).position;
  remote.asset_id='LINE_015'; remote.snapshot_id='test:LINE_015:82';
  remote.operation={id:'remote-op',asset_id:'LINE_015',sensor_id:'Drone 5',origin_asset:'LINE_009',status:'completed',observation_mode:'on_site',inspection_due_at:82};
  remote.route={origin_asset:'LINE_009',target_asset:'LINE_015',sensor_id:'Drone 5',departure_at:52,arrival_at:78,distance_km:30.5,flight_speed_mps:20,coordinates:[position('LINE_009'),position('LINE_015')]};
  const drone=remote.fleet.find(d=>d.sensor_id==='Drone 5');
  Object.assign(drone,{asset_id:'LINE_015',position:position('LINE_015'),status:'charging'});
  remote.explanation={assessment:{asset_id:'LINE_015',status:'Normal',anomaly:.000580163,evidence:[]},reading:{asset_id:'LINE_015',temperature_c:21,vibration_rms:.1,tilt_deg:0,voltage_pu:1},calculation:{available:true,summaries:{prior:{anomaly:.049375},telemetry_only:{anomaly:.000996927},with_visual:{anomaly:.000580163}}},visual:{used:true,evidence:{asset_id:'LINE_015',result:'clear',modality:'rgb'}}};
  remote.narrative={status:'Normal · continue monitoring',what:'LINE_015 has its own stationary readings.',next:'Continue monitoring LINE_015.'};
  remote.candidates=[]; remote.inspection_requests=[]; remote.human_alerts=[];
  remote.recommendations=[{action:'monitor',label:'Continue monitoring',recommended:true}];
  data.frames=[nearby,remote];
  data.chapters=[{id:'nearby_result',kind:'result',title:'Nearby imagery',asset_id:'LINE_058',minute:82,duration_seconds:10,why:'Preserve the missing measurements.'},{id:'bn_update',kind:'followup',title:'Target evidence',asset_id:'LINE_015',minute:82,duration_seconds:15,why:'Use the same target window.'}];
  data.validation={metadata:{model_version:data.metadata.model_version,code_hash:data.metadata.code_hash}};
  const {window,element,evidenceButtons}=bootReplay(data);
  window.GridScout.goChapter(1);
  assert.equal(window.GridScout.getState().asset_id,'LINE_015');
  assert.equal(element('chapter-number').textContent,'02 / 02');
  assert.equal(element('replay-duration').textContent,'Synthetic replay · 25 sec');
  assert.match(element('story-snapshot').textContent,/test:LINE_015:82/);
  assert.match(element('map-location').textContent,/^LINE_015/);
  assert.match(element('mission-map').innerHTML,/data-map-asset="LINE_015"/);
  assert.doesNotMatch(element('mission-map').innerHTML,/data-map-asset="LINE_058"/);
  assert.match(element('story-metric').innerHTML,/0\.100%/);
  assert.match(element('story-metric').innerHTML,/0\.058%/);
  assert.match(element('story-metric').innerHTML,/4\.938%/);
  assert.match(element('story-metric').innerHTML,/Continue monitoring/);
  window.GridScout.setPage('dashboard');
  assert.match(element('dashboard-context').textContent,/^LINE_015/);
  assert.match(element('evidence-content').innerHTML,/ASSET \/ LINE_015/);
  assert.doesNotMatch(element('evidence-content').innerHTML,/ASSET \/ LINE_058/);
  evidenceButtons.find(b=>b.dataset.evidence==='network').handlers.click();
  assert.match(element('evidence-content').innerHTML,/LINE_015 \/ SAME WINDOW/);
  element('snapshot-select').value=nearby.snapshot_id;
  element('snapshot-select').handlers.change();
  assert.match(element('dashboard-context').textContent,/^LINE_058/);
  assert.match(element('evidence-content').innerHTML,/LINE_058 \/ SAME WINDOW/);
  assert.equal(window.GridScout.getState().evidence_asset_id,'LINE_058');
});


test('every recorded chapter frame preserves its asset through story and evidence navigation', () => {
  const data=JSON.parse(fs.readFileSync(path.join(root,'artifacts/showcase_data.json'),'utf8'));
  const {window,element,evidenceButtons}=bootReplay(data);
  let start=0;
  for(const chapter of data.chapters) {
    const minutes=chapter.frame_minutes || [chapter.minute];
    for(let step=0;step<minutes.length;step++) {
      window.GridScout.setPage('showcase');
      element('scrubber').value=start+chapter.duration_seconds*(step+.5)/minutes.length;
      element('scrubber').handlers.input();
      const state=window.GridScout.getState(), expected=data.frames.find(f=>f.asset_id===chapter.asset_id && f.minute===minutes[step]);
      assert.equal(state.asset_id,chapter.asset_id,chapter.id);
      assert.equal(state.snapshot_id,expected.snapshot_id,`${chapter.id} at T+${minutes[step]}`);
      assert.ok(element('story-snapshot').textContent.includes(expected.snapshot_id));
      if(chapter.kind!=='coverage')assert.ok(element('mission-map').innerHTML.includes(`data-map-asset="${chapter.asset_id}"`));
      window.GridScout.setPage('dashboard');
      assert.ok(element('dashboard-context').textContent.startsWith(chapter.asset_id));
      assert.equal(window.GridScout.getState().evidence_snapshot_id,expected.snapshot_id);
      evidenceButtons.find(b=>b.dataset.evidence==='network').handlers.click();
      assert.ok(element('evidence-content').innerHTML.includes(`${chapter.asset_id} / SAME WINDOW`));
    }
    start+=chapter.duration_seconds;
  }
  assert.equal(window.GridScout.getState().duration,data.metadata.duration_seconds);
  // Optional evidence snapshots can sit outside the narrated chapters.
  // Exercise all 42 records, including the extra nearby and later BN windows.
  for(const frame of data.frames) {
    element('snapshot-select').value=frame.snapshot_id;
    element('snapshot-select').handlers.change();
    assert.ok(element('dashboard-context').textContent.startsWith(frame.asset_id));
    for(const button of evidenceButtons) {
      button.handlers.click();
      const state=window.GridScout.getState();
      assert.equal(state.evidence_snapshot_id,frame.snapshot_id);
      assert.equal(state.evidence_asset_id,frame.asset_id);
      assert.ok(element('evidence-binding').textContent.includes(frame.snapshot_id));
      if(button.dataset.evidence==='network')assert.ok(element('evidence-content').innerHTML.includes(`${frame.asset_id} / SAME WINDOW`));
      if(button.dataset.evidence==='operations')assert.ok(element('evidence-content').innerHTML.includes(`ASSET / ${frame.asset_id}`));
    }
  }
});
