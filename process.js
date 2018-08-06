#!/usr/bin/node
"use strict";

const assert = require('assert');
const topsort = require('topsort');
const fs = require('fs');
const dagre = require('dagre');
const HashMap = require('hashmap');

const header = `<!doctype html>
<html>
  <head>
    <meta http-equiv="Content-Type" content="text/html;charset=UTF-8" />
    <script type="text/javascript" src="main.js"></script>
    <title></title>
  </head>
  <body>`;

function module_deps(data) {
    const out = [];
    for (const [name, mod] of Object.entries(data.modules)) {
        out.push([name, 1/0]);
        for (const cname in mod.cells) {
            const cell = mod.cells[cname];
            if (cell.type in data.modules)
                out.push([cell.type, name]);
        }
    }
    return out;
}

function order_ports(data) {
    const unmap = {A: 'in', Y: 'out'};
    const binmap = {A: 'in1', B: 'in2', Y: 'out'};
    const out = {};
    ['$and', '$or', '$xor', '$xnor'].forEach((nm) => out[nm] = binmap);
    ['$not'].forEach((nm) => out[nm] = unmap);
    for (const [name, mod] of Object.entries(data.modules)) {
        const portmap = {};
        const ins = [], outs = [];
        for (const pname in mod.ports) {
            portmap[pname] = pname;
        }
        out[name] = portmap;
    }
    return out;
}

function yosys_to_simcir(data, portmaps) {
    const out = {};
    for (const [name, mod] of Object.entries(data.modules)) {
        out[name] = yosys_to_simcir_mod(mod);
    }
    return out
}

function yosys_to_simcir_mod(mod) {
    const nets = new HashMap();
    const bits = new Map();
    const devnets = new Map();
    let n = 0;
    function gen_name() {
        const nm =  'dev' + n++;
        devnets.set(nm, new Map());
        return nm;
    }
    function get_net(k) {
        // fix up bad JSON from yosys :(
        for (const i in k)
            if (typeof k[i] == 'string') k[i] = Number(k[i]);
        // create net if does not exist yet
        if (!nets.has(k))
            nets.set(k, {source: undefined, targets: []});
        return nets.get(k);
    }
    function add_net_source(k, d, p) {
        const net = get_net(k);
        assert(net.source === undefined);
        net.source = { id: d, port: p };
        for (const [nbit, bit] of k.entries()) {
            bits.set(bit, { id: d, port: p, num: nbit });
        }
        devnets.get(d).set(p, k);
    }
    function add_net_target(k, d, p) {
        const net = get_net(k);
        net.targets.push({ id: d, port: p });
        devnets.get(d).set(p, k);
    }
    const mout = {
        devices: {},
        connectors: []
    }
    // Add inputs/outputs
    for (const [pname, port] of Object.entries(mod.ports)) {
        const dname = gen_name();
        const dev = {
            label: pname,
            net: pname,
            order: n,
            bits: port.bits.length
        };
        switch (port.direction) {
            case 'input':
                dev.type = '$input';
                add_net_source(port.bits, dname, 'out');
                break;
            case 'output':
                dev.type = '$output';
                add_net_target(port.bits, dname, 'in');
                break;
            default: throw Error('Invalid port direction: ' + port.direction);
        }
        mout.devices[dname] = dev;
    }
    // Add gates
    for (const [cname, cell] of Object.entries(mod.cells)) {
        const portmap = portmaps[cell.type];
        const dname = gen_name();
        const dev = {
            label: cname
        };
        dev.type = cell.type;
        switch (cell.type) {
            case '$not':
                assert(cell.connections.A.length == cell.connections.Y.length);
                assert(cell.port_directions.A == 'input');
                assert(cell.port_directions.Y == 'output');
                dev.bits = cell.connections.Y.length;
                break;
            case '$and': case '$or': case '$xor': case '$xnor':
                assert(cell.connections.A.length == cell.connections.Y.length);
                assert(cell.connections.B.length == cell.connections.Y.length);
                assert(cell.port_directions.A == 'input');
                assert(cell.port_directions.B == 'input');
                assert(cell.port_directions.Y == 'output');
                dev.bits = cell.connections.Y.length;
                break;
            default:
                //throw Error('Invalid cell type: ' + cell.type);
        }
        for (const [pname, pdir] of Object.entries(cell.port_directions)) {
            const pconn = cell.connections[pname];
            switch (pdir) {
                case 'input':
                    add_net_target(pconn, dname, portmap[pname]);
                    break;
                case 'output':
                    add_net_source(pconn, dname, portmap[pname]);
                    break;
                default:
                    throw Error('Invalid port direction: ' + pdir);
            }
        }
        mout.devices[dname] = dev;
    }
    // Group bits into nets for complex sources
    for (const [nbits, net] of nets.entries()) {
        if (net.source !== undefined) continue;
        const groups = [[]];
        let group = [];
        let pbitinfo = undefined;
        for (const bit of nbits) {
            let bitinfo = bits.get(bit);
            if (bitinfo == undefined && (bit == 0 || bit == 1))
                bitinfo = 'const';
            if (groups.slice(-1)[0].length > 0 && 
                   (typeof bitinfo != typeof pbitinfo ||
                        typeof bitinfo == 'object' &&
                        typeof pbitinfo == 'object' &&
                            (bitinfo.id != pbitinfo.id ||
                             bitinfo.port != pbitinfo.port ||
                             bitinfo.num != pbitinfo.num + 1))) {
                groups.push([]);
            }
            groups.slice(-1)[0].push(bit);
            pbitinfo = bitinfo;
        }
        if (groups.length == 1) continue;
        const dname = gen_name();
        const dev = {
            type: '$busgroup',
            groups: groups.map(g => g.length)
        };
        add_net_source(nbits, dname, 'out');
        for (const [gn, group] of groups.entries()) {
            add_net_target(group, dname, 'in' + gn);
        }
        mout.devices[dname] = dev;
    }
    // Add constants
    for (const [nbits, net] of nets.entries()) {
        if (net.source !== undefined) continue;
        if (!nbits.every(x => x == 0 || x == 1)) continue;
        const dname = gen_name();
        const val = nbits.map(x => x == 1 ? 1 : -1);
        const dev = {
//            label: String(val), // TODO
            type: '$constant',
            constant: val
        };
        add_net_source(nbits, dname, 'out');
        mout.devices[dname] = dev;
    }
    // Select bits from complex targets
    for (const [nbits, net] of nets.entries()) {
        if (net.source !== undefined) continue;
        // constants should be already handled!
        assert(nbits.every(x => x > 1));
        const bitinfos = nbits.map(x => bits.get(x));
        if (!bitinfos.every(x => typeof x == 'object'))
            continue; // ignore not fully driven ports
        // complex sources should be already handled!
        assert(bitinfos.every(info => info.id == bitinfos[0].id &&
                                      info.port == bitinfos[0].port));
        const cconn = devnets.get(bitinfos[0].id).get(bitinfos[0].port);
        const dname = gen_name();
        const dev = {
            type: '$busslice',
            slice: {
                first: bitinfos[0].num,
                count: bitinfos.length,
                total: cconn.length
            }
        };
        add_net_source(nbits, dname, 'out');
        add_net_target(cconn, dname, 'in');
        mout.devices[dname] = dev;
    }
    // Generate connections between devices
    for (const [nbits, net] of nets.entries()) {
        if (net.source === undefined) {
            console.warn('Undriven net: ' + nbits);
            continue;
        }
        for (const target in net.targets)
            mout.connectors.push({to: net.targets[target], from: net.source});
    }
    return mout;
}

function layout_circuit(circ) {
    const g = new dagre.graphlib.Graph();
    const devmap = {};
    let maxx = 0, maxy = 0;

    g.setGraph({rankdir: 'RL'});
    g.setDefaultEdgeLabel(function() { return {}; });

    for (const dev of circ.devices) {
        g.setNode(dev.id, {
            id: dev.id,
            width: 32,
            height: 32
        });
        devmap[dev.id] = dev;
    }

    for (const conn of circ.connectors) {
        g.setEdge(conn.from.id, conn.to.id);
    }

    dagre.layout(g);

    for (const nname of g.nodes()) {
        const node = g.node(nname);
        devmap[node.id].x = node.x;
        devmap[node.id].y = node.y;
        maxx = Math.max(maxx, node.x);
        maxy = Math.max(maxy, node.y);
        //console.log(nname + ":" + JSON.stringify(node));
    }

    circ.width = maxx + 256;
    circ.height = maxy + 64;
}

function layout_circuits(circs) {
    for (const name in circs) {
        layout_circuit(circs[name]);
    }
}

let obj = JSON.parse(fs.readFileSync('output.json', 'utf8'));
let portmaps = order_ports(obj);
let out = yosys_to_simcir(obj, portmaps);
//layout_circuits(out);
let toporder = topsort(module_deps(obj));
toporder.pop();
let toplevel = toporder.pop();
let output = out[toplevel];
for (const [name, dev] of Object.entries(output.devices)) {
    if (dev.type == '$input')
        dev.type = dev.bits == 1 ? '$button' : '$numentry';
    if (dev.type == '$output')
        dev.type = dev.bits == 1 ? '$lamp' : '$numdisplay';
}
output.subcircuits = {};
for (const x of toporder) output.subcircuits[x] = out[x];
console.log(header);
console.log('<div id="paper"></div><script>const circuit = new digitaljs.Circuit(');
console.log(JSON.stringify(out[toplevel], null, 2));
console.log(');const paper = circuit.displayOn($(\'#paper\'));</script></body></html>');

