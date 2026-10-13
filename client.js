// dsh-gateway Client half: the "IM 网关" settings page.
// Registered as a first-class sidebar entry (sidebar.panellist row + the `main`
// page it opens); polls /api/dsh-gateway/state while it is mounted.
//
// Layout: one page-level master/detail split — a narrow rail listing the
// channels (with the "新建通道" action at its top) and a detail pane beside it.
// The rail stays a single column so a 760px settings column keeps a usable pane
// width, and the pane measures ITSELF (`container:dsh-gw-pane/inline-size`) so
// its tile grid and field rows collapse on the pane's width, not the viewport's.
// The pane is either the platform picker (one tile per catalogue kind), a
// channel's editor, or an empty state; a channel's editor is one card per
// configuration group, and the pane header carries the identity, the status tag
// and the enable switch.
// Cards follow the settings-card grammar (settings-card fill/stroke, radius-xl)
// and the shell's seeded primitives supply the controls (Button / Input /
// Switch / Checkbox / SegmentedControl / Pill / Tag / StateDot / icons), so
// nothing is hand-drawn except the platform marks below.
//
// The form is schema-driven: the sidecar serves each channel kind's control
// groups (core/spec/channels.json merged with live octop-gateway defaults), so
// this half renders whatever the catalogue declares — text / password / switch
// / number / segmented — and never carries its own field list, label map, or
// credential classification. A channel's NAME is not a field either: the host
// derives it as `<platform label>-<6-character id>` when the channel is created.
//
// Resident-editor rules (unchanged):
//   1. Selecting a channel fills the editor with current server values.
//   2. Save unlocks only through dirty-checking (edit mode); no other source.
//   3. Status polling never refills a dirty form; clean forms refill only when
//      the server fingerprint actually changed (external edit).
//   4. Secrets are never echoed: password inputs stay empty; empty = keep,
//      typing = set, 清除 = clear; only a configured boolean is displayed.
//   5. Identity fields (kind, secrets) are locked while the channel is enabled.
window.__ModuleLoader__.load({
  id: '@slothtron/dsh-gateway',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback } = React
    const {
      Button,
      Input,
      Switch,
      Checkbox,
      SegmentedControl,
      Pill,
      Tag,
      StateDot,
      IconPlusOutlineRegular,
      IconRefreshOutlineRegular,
      IconTrashOutlineRegular,
      IconRightUpOutlineRegular,
      IconChevronDownOutlineRegular,
      IconFolderOpenOutlineRegular,
      IconWarningTriangleOutlineRegular,
      IconApiOutlineRegular,
    } = require('@deepseek-ai/dsh-client-ui-primitives')

    // ---- vendored: platform marks ----
// Vendored third-party code — do not edit by hand.
//
// Platform mark paths borrowed from the "dsh-im" project — a separate,
// out-of-repo codebase — and reduced to the four kinds this catalogue offers.
// The license notice below is the obligation that travels with the paths; it is
// quoted rather than pointed at, so this file stays self-contained.
// Monochrome marks are drawn with `currentColor` so the tile can tint them from
// the catalogue's `color`; the multicolour one keeps its own fills. These marks
// are trademarks of their respective owners, used only to identify the platform
// a channel connects to.
//
// MIT License
//
// Copyright (c) 2026 xmanrui
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
    const LOGO_PATHS = {
      // viewBox 0 0 24 24, monochrome
      weixin: ['M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178 1.17 1.17 0 0 1-1.162-1.178c0-.651.52-1.18 1.162-1.18zm5.34 2.867c-1.797-.052-3.746.512-5.28 1.786-1.72 1.428-2.687 3.72-1.78 6.22.942 2.453 3.666 4.229 6.884 4.229.826 0 1.622-.12 2.361-.336a.722.722 0 0 1 .598.082l1.584.926a.272.272 0 0 0 .14.047c.134 0 .24-.111.24-.247 0-.06-.023-.12-.038-.177l-.327-1.233a.582.582 0 0 1-.023-.156.49.49 0 0 1 .201-.398C23.024 18.48 24 16.82 24 14.98c0-3.21-2.931-5.837-6.656-6.088V8.89c-.135-.01-.27-.027-.407-.03zm-2.53 3.274c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.97-.982zm4.844 0c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.969-.982z'],
      qq: ['M21.395 15.035a40 40 0 0 0-.803-2.264l-1.079-2.695c.001-.032.014-.562.014-.836C19.526 4.632 17.351 0 12 0S4.474 4.632 4.474 9.241c0 .274.013.804.014.836l-1.08 2.695a39 39 0 0 0-.802 2.264c-1.021 3.283-.69 4.643-.438 4.673.54.065 2.103-2.472 2.103-2.472 0 1.469.756 3.387 2.394 4.771-.612.188-1.363.479-1.845.835-.434.32-.379.646-.301.778.343.578 5.883.369 7.482.189 1.6.18 7.14.389 7.483-.189.078-.132.132-.458-.301-.778-.483-.356-1.233-.646-1.846-.836 1.637-1.384 2.393-3.302 2.393-4.771 0 0 1.563 2.537 2.103 2.472.251-.03.581-1.39-.438-4.673'],
      // viewBox 0 0 48 48, monochrome
      dingtalk: ['M37.05 22.783c-6.758-5.216-14.378-12.128-22.73-19.538-.655-.585-1.242-.354-1.536.42-1.88 4.973-.058 9.386 2.889 11.932s7.368 4.912 10.058 6.155c.105.049.013.203-.093.163-4.953-2.182-8.397-3.765-13.07-7.368-.497-.388-1.01-.242-1.07.521-.384 4.748 2.657 8.483 6.058 9.745 2.1.781 4.398 1.212 6.53 1.474.109.015.084.178-.027.178-2.747.01-6.058-.654-8.935-1.751-.606-.233-.818.25-.722.633.491 2.008 2.974 5.076 6.926 5.73a12 12 0 0 0 2.228.115c.164 0 .208.089.154.217q-2.685 4.6-2.803 4.797c-.091.152-.036.275.156.275h3.543c.164 0 .264.106.18.246l-4.958 8.196c-.191.328.035.565.395.301s15.212-11.133 15.636-11.448c.195-.142.148-.327-.124-.327h-3.18c-.206 0-.252-.14-.111-.28.14-.141 3.602-3.594 4.837-4.888 1.283-1.35 1.938-3.825-.231-5.498'],
    }
    const LOGO_VIEW_BOX = { weixin: '0 0 24 24', qq: '0 0 24 24', dingtalk: '0 0 48 48' }
    const FEISHU_PATHS = [
      { fill: '#00D6B9', d: 'M7.2 4.5h7.6c1.2 0 2.1.55 2.7 1.58 1.05 1.8 1.55 3.45 1.58 4.95-2.04-.62-4.2-.15-6.22 1.45C11.3 9.7 9.42 7.04 7.2 4.5Z' },
      { fill: '#1456B8', d: 'M10.8 13.55c3.3-2.93 5.72-4.24 9.47-2.52-1.2 1.45-2.27 4.18-3.86 5.43-1.67 1.31-3.9.5-5.61-.64v-2.27Z' },
      { fill: '#3370FF', d: 'M4.4 8.35c3.47 3.61 7.25 6.1 10.33 5.7 1.06-.14 2.2-.72 3.4-1.72-1.04 2.65-2.6 4.8-5.06 6-2.46 1.2-5.56.52-7.42-.72A2.76 2.76 0 0 1 4.4 15.3V8.35Z' },
    ]

    // ---- vendored: QR encoder (see the notice inside) ----
// Vendored third-party code — do not edit by hand; regenerate with the
// documented script and re-run the QR tests.
//
// QR Code generator, derived from the "QRCode for JavaScript" library.
// Copyright (c) 2009 Kazuhiko Arase
// Copyright (c) 2012 davidshimjs
// Copyright (c) 2016 papnkukn
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

    // Encodes a string into a QR module matrix. Isolated in an IIFE so none of
    // its many helper names leak into this factory scope.
    const QrCode = (() => {
      //---------------------------------------------------------------------
      // QRCode for JavaScript
      //
      // Copyright (c) 2009 Kazuhiko Arase
      //
      // URL: http://www.d-project.com/
      //
      // Licensed under the MIT license:
      //   http://www.opensource.org/licenses/mit-license.php
      //
      // The word "QR Code" is registered trademark of 
      // DENSO WAVE INCORPORATED
      //   http://www.denso-wave.com/qrcode/faqpatent-e.html
      //
      //---------------------------------------------------------------------
      function QR8bitByte(data) {
        this.mode = QRMode.MODE_8BIT_BYTE;
        this.data = data;
        this.parsedData = [];

        // Added to support UTF-8 Characters
        for (var i = 0, l = this.data.length; i < l; i++) {
          var byteArray = [];
          var code = this.data.charCodeAt(i);

          if (code > 0x10000) {
            byteArray[0] = 0xF0 | ((code & 0x1C0000) >>> 18);
            byteArray[1] = 0x80 | ((code & 0x3F000) >>> 12);
            byteArray[2] = 0x80 | ((code & 0xFC0) >>> 6);
            byteArray[3] = 0x80 | (code & 0x3F);
          } else if (code > 0x800) {
            byteArray[0] = 0xE0 | ((code & 0xF000) >>> 12);
            byteArray[1] = 0x80 | ((code & 0xFC0) >>> 6);
            byteArray[2] = 0x80 | (code & 0x3F);
          } else if (code > 0x80) {
            byteArray[0] = 0xC0 | ((code & 0x7C0) >>> 6);
            byteArray[1] = 0x80 | (code & 0x3F);
          } else {
            byteArray[0] = code;
          }

          this.parsedData.push(byteArray);
        }

        this.parsedData = Array.prototype.concat.apply([], this.parsedData);

        if (this.parsedData.length != this.data.length) {
          this.parsedData.unshift(191);
          this.parsedData.unshift(187);
          this.parsedData.unshift(239);
        }
      }

      QR8bitByte.prototype = {
        getLength: function (buffer) {
          return this.parsedData.length;
        },
        write: function (buffer) {
          for (var i = 0, l = this.parsedData.length; i < l; i++) {
            buffer.put(this.parsedData[i], 8);
          }
        }
      };

      function QRCodeModel(typeNumber, errorCorrectLevel) {
        this.typeNumber = typeNumber;
        this.errorCorrectLevel = errorCorrectLevel;
        this.modules = null;
        this.moduleCount = 0;
        this.dataCache = null;
        this.dataList = [];
      }

      QRCodeModel.prototype={addData:function(data){var newData=new QR8bitByte(data);this.dataList.push(newData);this.dataCache=null;},isDark:function(row,col){if(row<0||this.moduleCount<=row||col<0||this.moduleCount<=col){throw new Error(row+","+col);}
      return this.modules[row][col];},getModuleCount:function(){return this.moduleCount;},make:function(){this.makeImpl(false,this.getBestMaskPattern());},makeImpl:function(test,maskPattern){this.moduleCount=this.typeNumber*4+17;this.modules=new Array(this.moduleCount);for(var row=0;row<this.moduleCount;row++){this.modules[row]=new Array(this.moduleCount);for(var col=0;col<this.moduleCount;col++){this.modules[row][col]=null;}}
      this.setupPositionProbePattern(0,0);this.setupPositionProbePattern(this.moduleCount-7,0);this.setupPositionProbePattern(0,this.moduleCount-7);this.setupPositionAdjustPattern();this.setupTimingPattern();this.setupTypeInfo(test,maskPattern);if(this.typeNumber>=7){this.setupTypeNumber(test);}
      if(this.dataCache==null){this.dataCache=QRCodeModel.createData(this.typeNumber,this.errorCorrectLevel,this.dataList);}
      this.mapData(this.dataCache,maskPattern);},setupPositionProbePattern:function(row,col){for(var r=-1;r<=7;r++){if(row+r<=-1||this.moduleCount<=row+r)continue;for(var c=-1;c<=7;c++){if(col+c<=-1||this.moduleCount<=col+c)continue;if((0<=r&&r<=6&&(c==0||c==6))||(0<=c&&c<=6&&(r==0||r==6))||(2<=r&&r<=4&&2<=c&&c<=4)){this.modules[row+r][col+c]=true;}else{this.modules[row+r][col+c]=false;}}}},getBestMaskPattern:function(){var minLostPoint=0;var pattern=0;for(var i=0;i<8;i++){this.makeImpl(true,i);var lostPoint=QRUtil.getLostPoint(this);if(i==0||minLostPoint>lostPoint){minLostPoint=lostPoint;pattern=i;}}
      return pattern;},createMovieClip:function(target_mc,instance_name,depth){var qr_mc=target_mc.createEmptyMovieClip(instance_name,depth);var cs=1;this.make();for(var row=0;row<this.modules.length;row++){var y=row*cs;for(var col=0;col<this.modules[row].length;col++){var x=col*cs;var dark=this.modules[row][col];if(dark){qr_mc.beginFill(0,100);qr_mc.moveTo(x,y);qr_mc.lineTo(x+cs,y);qr_mc.lineTo(x+cs,y+cs);qr_mc.lineTo(x,y+cs);qr_mc.endFill();}}}
      return qr_mc;},setupTimingPattern:function(){for(var r=8;r<this.moduleCount-8;r++){if(this.modules[r][6]!=null){continue;}
      this.modules[r][6]=(r%2==0);}
      for(var c=8;c<this.moduleCount-8;c++){if(this.modules[6][c]!=null){continue;}
      this.modules[6][c]=(c%2==0);}},setupPositionAdjustPattern:function(){var pos=QRUtil.getPatternPosition(this.typeNumber);for(var i=0;i<pos.length;i++){for(var j=0;j<pos.length;j++){var row=pos[i];var col=pos[j];if(this.modules[row][col]!=null){continue;}
      for(var r=-2;r<=2;r++){for(var c=-2;c<=2;c++){if(r==-2||r==2||c==-2||c==2||(r==0&&c==0)){this.modules[row+r][col+c]=true;}else{this.modules[row+r][col+c]=false;}}}}}},setupTypeNumber:function(test){var bits=QRUtil.getBCHTypeNumber(this.typeNumber);for(var i=0;i<18;i++){var mod=(!test&&((bits>>i)&1)==1);this.modules[Math.floor(i/3)][i%3+this.moduleCount-8-3]=mod;}
      for(var i=0;i<18;i++){var mod=(!test&&((bits>>i)&1)==1);this.modules[i%3+this.moduleCount-8-3][Math.floor(i/3)]=mod;}},setupTypeInfo:function(test,maskPattern){var data=(this.errorCorrectLevel<<3)|maskPattern;var bits=QRUtil.getBCHTypeInfo(data);for(var i=0;i<15;i++){var mod=(!test&&((bits>>i)&1)==1);if(i<6){this.modules[i][8]=mod;}else if(i<8){this.modules[i+1][8]=mod;}else{this.modules[this.moduleCount-15+i][8]=mod;}}
      for(var i=0;i<15;i++){var mod=(!test&&((bits>>i)&1)==1);if(i<8){this.modules[8][this.moduleCount-i-1]=mod;}else if(i<9){this.modules[8][15-i-1+1]=mod;}else{this.modules[8][15-i-1]=mod;}}
      this.modules[this.moduleCount-8][8]=(!test);},mapData:function(data,maskPattern){var inc=-1;var row=this.moduleCount-1;var bitIndex=7;var byteIndex=0;for(var col=this.moduleCount-1;col>0;col-=2){if(col==6)col--;while(true){for(var c=0;c<2;c++){if(this.modules[row][col-c]==null){var dark=false;if(byteIndex<data.length){dark=(((data[byteIndex]>>>bitIndex)&1)==1);}
      var mask=QRUtil.getMask(maskPattern,row,col-c);if(mask){dark=!dark;}
      this.modules[row][col-c]=dark;bitIndex--;if(bitIndex==-1){byteIndex++;bitIndex=7;}}}
      row+=inc;if(row<0||this.moduleCount<=row){row-=inc;inc=-inc;break;}}}}};QRCodeModel.PAD0=0xEC;QRCodeModel.PAD1=0x11;QRCodeModel.createData=function(typeNumber,errorCorrectLevel,dataList){var rsBlocks=QRRSBlock.getRSBlocks(typeNumber,errorCorrectLevel);var buffer=new QRBitBuffer();for(var i=0;i<dataList.length;i++){var data=dataList[i];buffer.put(data.mode,4);buffer.put(data.getLength(),QRUtil.getLengthInBits(data.mode,typeNumber));data.write(buffer);}
      var totalDataCount=0;for(var i=0;i<rsBlocks.length;i++){totalDataCount+=rsBlocks[i].dataCount;}
      if(buffer.getLengthInBits()>totalDataCount*8){throw new Error("code length overflow. ("
      +buffer.getLengthInBits()
      +">"
      +totalDataCount*8
      +")");}
      if(buffer.getLengthInBits()+4<=totalDataCount*8){buffer.put(0,4);}
      while(buffer.getLengthInBits()%8!=0){buffer.putBit(false);}
      while(true){if(buffer.getLengthInBits()>=totalDataCount*8){break;}
      buffer.put(QRCodeModel.PAD0,8);if(buffer.getLengthInBits()>=totalDataCount*8){break;}
      buffer.put(QRCodeModel.PAD1,8);}
      return QRCodeModel.createBytes(buffer,rsBlocks);};QRCodeModel.createBytes=function(buffer,rsBlocks){var offset=0;var maxDcCount=0;var maxEcCount=0;var dcdata=new Array(rsBlocks.length);var ecdata=new Array(rsBlocks.length);for(var r=0;r<rsBlocks.length;r++){var dcCount=rsBlocks[r].dataCount;var ecCount=rsBlocks[r].totalCount-dcCount;maxDcCount=Math.max(maxDcCount,dcCount);maxEcCount=Math.max(maxEcCount,ecCount);dcdata[r]=new Array(dcCount);for(var i=0;i<dcdata[r].length;i++){dcdata[r][i]=0xff&buffer.buffer[i+offset];}
      offset+=dcCount;var rsPoly=QRUtil.getErrorCorrectPolynomial(ecCount);var rawPoly=new QRPolynomial(dcdata[r],rsPoly.getLength()-1);var modPoly=rawPoly.mod(rsPoly);ecdata[r]=new Array(rsPoly.getLength()-1);for(var i=0;i<ecdata[r].length;i++){var modIndex=i+modPoly.getLength()-ecdata[r].length;ecdata[r][i]=(modIndex>=0)?modPoly.get(modIndex):0;}}
      var totalCodeCount=0;for(var i=0;i<rsBlocks.length;i++){totalCodeCount+=rsBlocks[i].totalCount;}
      var data=new Array(totalCodeCount);var index=0;for(var i=0;i<maxDcCount;i++){for(var r=0;r<rsBlocks.length;r++){if(i<dcdata[r].length){data[index++]=dcdata[r][i];}}}
      for(var i=0;i<maxEcCount;i++){for(var r=0;r<rsBlocks.length;r++){if(i<ecdata[r].length){data[index++]=ecdata[r][i];}}}
      return data;};var QRMode={MODE_NUMBER:1<<0,MODE_ALPHA_NUM:1<<1,MODE_8BIT_BYTE:1<<2,MODE_KANJI:1<<3};var QRErrorCorrectLevel={L:1,M:0,Q:3,H:2};var QRMaskPattern={PATTERN000:0,PATTERN001:1,PATTERN010:2,PATTERN011:3,PATTERN100:4,PATTERN101:5,PATTERN110:6,PATTERN111:7};var QRUtil={PATTERN_POSITION_TABLE:[[],[6,18],[6,22],[6,26],[6,30],[6,34],[6,22,38],[6,24,42],[6,26,46],[6,28,50],[6,30,54],[6,32,58],[6,34,62],[6,26,46,66],[6,26,48,70],[6,26,50,74],[6,30,54,78],[6,30,56,82],[6,30,58,86],[6,34,62,90],[6,28,50,72,94],[6,26,50,74,98],[6,30,54,78,102],[6,28,54,80,106],[6,32,58,84,110],[6,30,58,86,114],[6,34,62,90,118],[6,26,50,74,98,122],[6,30,54,78,102,126],[6,26,52,78,104,130],[6,30,56,82,108,134],[6,34,60,86,112,138],[6,30,58,86,114,142],[6,34,62,90,118,146],[6,30,54,78,102,126,150],[6,24,50,76,102,128,154],[6,28,54,80,106,132,158],[6,32,58,84,110,136,162],[6,26,54,82,110,138,166],[6,30,58,86,114,142,170]],G15:(1<<10)|(1<<8)|(1<<5)|(1<<4)|(1<<2)|(1<<1)|(1<<0),G18:(1<<12)|(1<<11)|(1<<10)|(1<<9)|(1<<8)|(1<<5)|(1<<2)|(1<<0),G15_MASK:(1<<14)|(1<<12)|(1<<10)|(1<<4)|(1<<1),getBCHTypeInfo:function(data){var d=data<<10;while(QRUtil.getBCHDigit(d)-QRUtil.getBCHDigit(QRUtil.G15)>=0){d^=(QRUtil.G15<<(QRUtil.getBCHDigit(d)-QRUtil.getBCHDigit(QRUtil.G15)));}
      return((data<<10)|d)^QRUtil.G15_MASK;},getBCHTypeNumber:function(data){var d=data<<12;while(QRUtil.getBCHDigit(d)-QRUtil.getBCHDigit(QRUtil.G18)>=0){d^=(QRUtil.G18<<(QRUtil.getBCHDigit(d)-QRUtil.getBCHDigit(QRUtil.G18)));}
      return(data<<12)|d;},getBCHDigit:function(data){var digit=0;while(data!=0){digit++;data>>>=1;}
      return digit;},getPatternPosition:function(typeNumber){return QRUtil.PATTERN_POSITION_TABLE[typeNumber-1];},getMask:function(maskPattern,i,j){switch(maskPattern){case QRMaskPattern.PATTERN000:return(i+j)%2==0;case QRMaskPattern.PATTERN001:return i%2==0;case QRMaskPattern.PATTERN010:return j%3==0;case QRMaskPattern.PATTERN011:return(i+j)%3==0;case QRMaskPattern.PATTERN100:return(Math.floor(i/2)+Math.floor(j/3))%2==0;case QRMaskPattern.PATTERN101:return(i*j)%2+(i*j)%3==0;case QRMaskPattern.PATTERN110:return((i*j)%2+(i*j)%3)%2==0;case QRMaskPattern.PATTERN111:return((i*j)%3+(i+j)%2)%2==0;default:throw new Error("bad maskPattern:"+maskPattern);}},getErrorCorrectPolynomial:function(errorCorrectLength){var a=new QRPolynomial([1],0);for(var i=0;i<errorCorrectLength;i++){a=a.multiply(new QRPolynomial([1,QRMath.gexp(i)],0));}
      return a;},getLengthInBits:function(mode,type){if(1<=type&&type<10){switch(mode){case QRMode.MODE_NUMBER:return 10;case QRMode.MODE_ALPHA_NUM:return 9;case QRMode.MODE_8BIT_BYTE:return 8;case QRMode.MODE_KANJI:return 8;default:throw new Error("mode:"+mode);}}else if(type<27){switch(mode){case QRMode.MODE_NUMBER:return 12;case QRMode.MODE_ALPHA_NUM:return 11;case QRMode.MODE_8BIT_BYTE:return 16;case QRMode.MODE_KANJI:return 10;default:throw new Error("mode:"+mode);}}else if(type<41){switch(mode){case QRMode.MODE_NUMBER:return 14;case QRMode.MODE_ALPHA_NUM:return 13;case QRMode.MODE_8BIT_BYTE:return 16;case QRMode.MODE_KANJI:return 12;default:throw new Error("mode:"+mode);}}else{throw new Error("type:"+type);}},getLostPoint:function(qrCode){var moduleCount=qrCode.getModuleCount();var lostPoint=0;for(var row=0;row<moduleCount;row++){for(var col=0;col<moduleCount;col++){var sameCount=0;var dark=qrCode.isDark(row,col);for(var r=-1;r<=1;r++){if(row+r<0||moduleCount<=row+r){continue;}
      for(var c=-1;c<=1;c++){if(col+c<0||moduleCount<=col+c){continue;}
      if(r==0&&c==0){continue;}
      if(dark==qrCode.isDark(row+r,col+c)){sameCount++;}}}
      if(sameCount>5){lostPoint+=(3+sameCount-5);}}}
      for(var row=0;row<moduleCount-1;row++){for(var col=0;col<moduleCount-1;col++){var count=0;if(qrCode.isDark(row,col))count++;if(qrCode.isDark(row+1,col))count++;if(qrCode.isDark(row,col+1))count++;if(qrCode.isDark(row+1,col+1))count++;if(count==0||count==4){lostPoint+=3;}}}
      for(var row=0;row<moduleCount;row++){for(var col=0;col<moduleCount-6;col++){if(qrCode.isDark(row,col)&&!qrCode.isDark(row,col+1)&&qrCode.isDark(row,col+2)&&qrCode.isDark(row,col+3)&&qrCode.isDark(row,col+4)&&!qrCode.isDark(row,col+5)&&qrCode.isDark(row,col+6)){lostPoint+=40;}}}
      for(var col=0;col<moduleCount;col++){for(var row=0;row<moduleCount-6;row++){if(qrCode.isDark(row,col)&&!qrCode.isDark(row+1,col)&&qrCode.isDark(row+2,col)&&qrCode.isDark(row+3,col)&&qrCode.isDark(row+4,col)&&!qrCode.isDark(row+5,col)&&qrCode.isDark(row+6,col)){lostPoint+=40;}}}
      var darkCount=0;for(var col=0;col<moduleCount;col++){for(var row=0;row<moduleCount;row++){if(qrCode.isDark(row,col)){darkCount++;}}}
      var ratio=Math.abs(100*darkCount/moduleCount/moduleCount-50)/5;lostPoint+=ratio*10;return lostPoint;}};var QRMath={glog:function(n){if(n<1){throw new Error("glog("+n+")");}
      return QRMath.LOG_TABLE[n];},gexp:function(n){while(n<0){n+=255;}
      while(n>=256){n-=255;}
      return QRMath.EXP_TABLE[n];},EXP_TABLE:new Array(256),LOG_TABLE:new Array(256)};for(var i=0;i<8;i++){QRMath.EXP_TABLE[i]=1<<i;}
      for(var i=8;i<256;i++){QRMath.EXP_TABLE[i]=QRMath.EXP_TABLE[i-4]^QRMath.EXP_TABLE[i-5]^QRMath.EXP_TABLE[i-6]^QRMath.EXP_TABLE[i-8];}
      for(var i=0;i<255;i++){QRMath.LOG_TABLE[QRMath.EXP_TABLE[i]]=i;}
      function QRPolynomial(num,shift){if(num.length==undefined){throw new Error(num.length+"/"+shift);}
      var offset=0;while(offset<num.length&&num[offset]==0){offset++;}
      this.num=new Array(num.length-offset+shift);for(var i=0;i<num.length-offset;i++){this.num[i]=num[i+offset];}}
      QRPolynomial.prototype={get:function(index){return this.num[index];},getLength:function(){return this.num.length;},multiply:function(e){var num=new Array(this.getLength()+e.getLength()-1);for(var i=0;i<this.getLength();i++){for(var j=0;j<e.getLength();j++){num[i+j]^=QRMath.gexp(QRMath.glog(this.get(i))+QRMath.glog(e.get(j)));}}
      return new QRPolynomial(num,0);},mod:function(e){if(this.getLength()-e.getLength()<0){return this;}
      var ratio=QRMath.glog(this.get(0))-QRMath.glog(e.get(0));var num=new Array(this.getLength());for(var i=0;i<this.getLength();i++){num[i]=this.get(i);}
      for(var i=0;i<e.getLength();i++){num[i]^=QRMath.gexp(QRMath.glog(e.get(i))+ratio);}
      return new QRPolynomial(num,0).mod(e);}};function QRRSBlock(totalCount,dataCount){this.totalCount=totalCount;this.dataCount=dataCount;}
      QRRSBlock.RS_BLOCK_TABLE=[[1,26,19],[1,26,16],[1,26,13],[1,26,9],[1,44,34],[1,44,28],[1,44,22],[1,44,16],[1,70,55],[1,70,44],[2,35,17],[2,35,13],[1,100,80],[2,50,32],[2,50,24],[4,25,9],[1,134,108],[2,67,43],[2,33,15,2,34,16],[2,33,11,2,34,12],[2,86,68],[4,43,27],[4,43,19],[4,43,15],[2,98,78],[4,49,31],[2,32,14,4,33,15],[4,39,13,1,40,14],[2,121,97],[2,60,38,2,61,39],[4,40,18,2,41,19],[4,40,14,2,41,15],[2,146,116],[3,58,36,2,59,37],[4,36,16,4,37,17],[4,36,12,4,37,13],[2,86,68,2,87,69],[4,69,43,1,70,44],[6,43,19,2,44,20],[6,43,15,2,44,16],[4,101,81],[1,80,50,4,81,51],[4,50,22,4,51,23],[3,36,12,8,37,13],[2,116,92,2,117,93],[6,58,36,2,59,37],[4,46,20,6,47,21],[7,42,14,4,43,15],[4,133,107],[8,59,37,1,60,38],[8,44,20,4,45,21],[12,33,11,4,34,12],[3,145,115,1,146,116],[4,64,40,5,65,41],[11,36,16,5,37,17],[11,36,12,5,37,13],[5,109,87,1,110,88],[5,65,41,5,66,42],[5,54,24,7,55,25],[11,36,12],[5,122,98,1,123,99],[7,73,45,3,74,46],[15,43,19,2,44,20],[3,45,15,13,46,16],[1,135,107,5,136,108],[10,74,46,1,75,47],[1,50,22,15,51,23],[2,42,14,17,43,15],[5,150,120,1,151,121],[9,69,43,4,70,44],[17,50,22,1,51,23],[2,42,14,19,43,15],[3,141,113,4,142,114],[3,70,44,11,71,45],[17,47,21,4,48,22],[9,39,13,16,40,14],[3,135,107,5,136,108],[3,67,41,13,68,42],[15,54,24,5,55,25],[15,43,15,10,44,16],[4,144,116,4,145,117],[17,68,42],[17,50,22,6,51,23],[19,46,16,6,47,17],[2,139,111,7,140,112],[17,74,46],[7,54,24,16,55,25],[34,37,13],[4,151,121,5,152,122],[4,75,47,14,76,48],[11,54,24,14,55,25],[16,45,15,14,46,16],[6,147,117,4,148,118],[6,73,45,14,74,46],[11,54,24,16,55,25],[30,46,16,2,47,17],[8,132,106,4,133,107],[8,75,47,13,76,48],[7,54,24,22,55,25],[22,45,15,13,46,16],[10,142,114,2,143,115],[19,74,46,4,75,47],[28,50,22,6,51,23],[33,46,16,4,47,17],[8,152,122,4,153,123],[22,73,45,3,74,46],[8,53,23,26,54,24],[12,45,15,28,46,16],[3,147,117,10,148,118],[3,73,45,23,74,46],[4,54,24,31,55,25],[11,45,15,31,46,16],[7,146,116,7,147,117],[21,73,45,7,74,46],[1,53,23,37,54,24],[19,45,15,26,46,16],[5,145,115,10,146,116],[19,75,47,10,76,48],[15,54,24,25,55,25],[23,45,15,25,46,16],[13,145,115,3,146,116],[2,74,46,29,75,47],[42,54,24,1,55,25],[23,45,15,28,46,16],[17,145,115],[10,74,46,23,75,47],[10,54,24,35,55,25],[19,45,15,35,46,16],[17,145,115,1,146,116],[14,74,46,21,75,47],[29,54,24,19,55,25],[11,45,15,46,46,16],[13,145,115,6,146,116],[14,74,46,23,75,47],[44,54,24,7,55,25],[59,46,16,1,47,17],[12,151,121,7,152,122],[12,75,47,26,76,48],[39,54,24,14,55,25],[22,45,15,41,46,16],[6,151,121,14,152,122],[6,75,47,34,76,48],[46,54,24,10,55,25],[2,45,15,64,46,16],[17,152,122,4,153,123],[29,74,46,14,75,47],[49,54,24,10,55,25],[24,45,15,46,46,16],[4,152,122,18,153,123],[13,74,46,32,75,47],[48,54,24,14,55,25],[42,45,15,32,46,16],[20,147,117,4,148,118],[40,75,47,7,76,48],[43,54,24,22,55,25],[10,45,15,67,46,16],[19,148,118,6,149,119],[18,75,47,31,76,48],[34,54,24,34,55,25],[20,45,15,61,46,16]];QRRSBlock.getRSBlocks=function(typeNumber,errorCorrectLevel){var rsBlock=QRRSBlock.getRsBlockTable(typeNumber,errorCorrectLevel);if(rsBlock==undefined){throw new Error("bad rs block @ typeNumber:"+typeNumber+"/errorCorrectLevel:"+errorCorrectLevel);}
      var length=rsBlock.length/3;var list=[];for(var i=0;i<length;i++){var count=rsBlock[i*3+0];var totalCount=rsBlock[i*3+1];var dataCount=rsBlock[i*3+2];for(var j=0;j<count;j++){list.push(new QRRSBlock(totalCount,dataCount));}}
      return list;};QRRSBlock.getRsBlockTable=function(typeNumber,errorCorrectLevel){switch(errorCorrectLevel){case QRErrorCorrectLevel.L:return QRRSBlock.RS_BLOCK_TABLE[(typeNumber-1)*4+0];case QRErrorCorrectLevel.M:return QRRSBlock.RS_BLOCK_TABLE[(typeNumber-1)*4+1];case QRErrorCorrectLevel.Q:return QRRSBlock.RS_BLOCK_TABLE[(typeNumber-1)*4+2];case QRErrorCorrectLevel.H:return QRRSBlock.RS_BLOCK_TABLE[(typeNumber-1)*4+3];default:return undefined;}};function QRBitBuffer(){this.buffer=[];this.length=0;}
      QRBitBuffer.prototype={get:function(index){var bufIndex=Math.floor(index/8);return((this.buffer[bufIndex]>>>(7-index%8))&1)==1;},put:function(num,length){for(var i=0;i<length;i++){this.putBit(((num>>>(length-i-1))&1)==1);}},getLengthInBits:function(){return this.length;},putBit:function(bit){var bufIndex=Math.floor(this.length/8);if(this.buffer.length<=bufIndex){this.buffer.push(0);}
      if(bit){this.buffer[bufIndex]|=(0x80>>>(this.length%8));}
      this.length++;}};var QRCodeLimitLength=[[17,14,11,7],[32,26,20,14],[53,42,32,24],[78,62,46,34],[106,84,60,44],[134,106,74,58],[154,122,86,64],[192,152,108,84],[230,180,130,98],[271,213,151,119],[321,251,177,137],[367,287,203,155],[425,331,241,177],[458,362,258,194],[520,412,292,220],[586,450,322,250],[644,504,364,280],[718,560,394,310],[792,624,442,338],[858,666,482,382],[929,711,509,403],[1003,779,565,439],[1091,857,611,461],[1171,911,661,511],[1273,997,715,535],[1367,1059,751,593],[1465,1125,805,625],[1528,1190,868,658],[1628,1264,908,698],[1732,1370,982,742],[1840,1452,1030,790],[1952,1538,1112,842],[2068,1628,1168,898],[2188,1722,1228,958],[2303,1809,1283,983],[2431,1911,1351,1051],[2563,1989,1423,1093],[2699,2099,1499,1139],[2809,2213,1579,1219],[2953,2331,1663,1273]];


      /** Constructor */
      function QRCode(options) {
        var instance = this;
        
        //Default options
        this.options = {
          padding: 4,
          width: 256, 
          height: 256,
          typeNumber: 4,
          color: "#000000",
          background: "#ffffff",
          ecl: "M"
        };
        
        //In case the options is string
        if (typeof options === 'string') {
          options = {
            content: options
          };
        }
        
        //Merge options
        if (options) {
          for (var i in options) {
            this.options[i] = options[i];
          }
        }
        
        if (typeof this.options.content !== 'string') {
          throw new Error("Expected 'content' as string!");
        }
        
        if (this.options.content.length === 0 /* || this.options.content.length > 7089 */) {
          throw new Error("Expected 'content' to be non-empty!");
        }
        
        if (!(this.options.padding >= 0)) {
          throw new Error("Expected 'padding' value to be non-negative!");
        }
        
        if (!(this.options.width > 0) || !(this.options.height > 0)) {
          throw new Error("Expected 'width' or 'height' value to be higher than zero!");
        }
        
        //Gets the error correction level
        function _getErrorCorrectLevel(ecl) {
          switch (ecl) {
              case "L":
                return QRErrorCorrectLevel.L;
                
              case "M":
                return QRErrorCorrectLevel.M;
                
              case "Q":
                return QRErrorCorrectLevel.Q;
                
              case "H":
                return QRErrorCorrectLevel.H;
                
              default:
                throw new Error("Unknwon error correction level: " + ecl);
            }
        }
        
        //Get type number
        function _getTypeNumber(content, ecl) {      
          var length = _getUTF8Length(content);
          
          var type = 1;
          var limit = 0;
          for (var i = 0, len = QRCodeLimitLength.length; i <= len; i++) {
            var table = QRCodeLimitLength[i];
            if (!table) {
              throw new Error("Content too long: expected " + limit + " but got " + length);
            }
            
            switch (ecl) {
              case "L":
                limit = table[0];
                break;
                
              case "M":
                limit = table[1];
                break;
                
              case "Q":
                limit = table[2];
                break;
                
              case "H":
                limit = table[3];
                break;
                
              default:
                throw new Error("Unknwon error correction level: " + ecl);
            }
            
            if (length <= limit) {
              break;
            }
            
            type++;
          }
          
          if (type > QRCodeLimitLength.length) {
            throw new Error("Content too long");
          }
          
          return type;
        }

        //Gets text length
        function _getUTF8Length(content) {
          var result = encodeURI(content).toString().replace(/\%[0-9a-fA-F]{2}/g, 'a');
          return result.length + (result.length != content ? 3 : 0);
        }
        
        //Generate QR Code matrix
        var content = this.options.content;
        var type = _getTypeNumber(content, this.options.ecl);
        var ecl = _getErrorCorrectLevel(this.options.ecl);
        this.qrcode = new QRCodeModel(type, ecl);
        this.qrcode.addData(content);
        this.qrcode.make();
      }

      /** Generates QR Code as SVG image */
      QRCode.prototype.svg = function(opt) {
        var options = this.options || { };
        var modules = this.qrcode.modules;
        
        if (typeof opt == "undefined") {
          opt = { container: options.container || "svg" };
        }
        
        //Apply new lines and indents in SVG?
        var pretty = typeof options.pretty != "undefined" ? !!options.pretty : true;
        
        var indent = pretty ? '  ' : '';
        var EOL = pretty ? '\r\n' : '';
        var width = options.width;
        var height = options.height;
        var length = modules.length;
        var xsize = width / (length + 2 * options.padding);
        var ysize = height / (length + 2 * options.padding);
        
        //Join (union, merge) rectangles into one shape?
        var join = typeof options.join != "undefined" ? !!options.join : false;
        
        //Swap the X and Y modules, pull request #2
        var swap = typeof options.swap != "undefined" ? !!options.swap : false;
        
        //Apply <?xml...?> declaration in SVG?
        var xmlDeclaration = typeof options.xmlDeclaration != "undefined" ? !!options.xmlDeclaration : true;
        
        //Populate with predefined shape instead of "rect" elements, thanks to @kkocdko
        var predefined = typeof options.predefined != "undefined" ? !!options.predefined : false;
        var defs = predefined ? indent + '<defs><path id="qrmodule" d="M0 0 h' + ysize + ' v' + xsize + ' H0 z" style="fill:' + options.color + ';shape-rendering:crispEdges;" /></defs>' + EOL : '';
        
        //Background rectangle
        var bgrect = indent + '<rect x="0" y="0" width="' + width + '" height="' + height + '" style="fill:' + options.background + ';shape-rendering:crispEdges;"/>' + EOL;
        
        //Rectangles representing modules
        var modrect = '';
        var pathdata = '';

        for (var y = 0; y < length; y++) {
          for (var x = 0; x < length; x++) {
            var module = modules[x][y];
            if (module) {
              
              var px = (x * xsize + options.padding * xsize);
              var py = (y * ysize + options.padding * ysize);
              
              //Some users have had issues with the QR Code, thanks to @danioso for the solution
              if (swap) {
                var t = px;
                px = py;
                py = t;
              }
              
              if (join) {
                //Module as a part of svg path data, thanks to @danioso
                var w = xsize + px
                var h = ysize + py

                px = (Number.isInteger(px))? Number(px): px.toFixed(2);
                py = (Number.isInteger(py))? Number(py): py.toFixed(2);
                w = (Number.isInteger(w))? Number(w): w.toFixed(2);
                h = (Number.isInteger(h))? Number(h): h.toFixed(2);

                pathdata += ('M' + px + ',' + py + ' V' + h + ' H' + w + ' V' + py + ' H' + px + ' Z ');
              }
              else if (predefined) {
                //Module as a predefined shape, thanks to @kkocdko
                modrect += indent + '<use x="' + px.toString() + '" y="' + py.toString() + '" href="#qrmodule" />' + EOL;
              }
              else {
                //Module as rectangle element
                modrect += indent + '<rect x="' + px.toString() + '" y="' + py.toString() + '" width="' + xsize + '" height="' + ysize + '" style="fill:' + options.color + ';shape-rendering:crispEdges;"/>' + EOL;
              }
            }
          }
        }
        
        if (join) {
          modrect = indent + '<path x="0" y="0" style="fill:' + options.color + ';shape-rendering:crispEdges;" d="' + pathdata + '" />';
        }

        var svg = "";
        switch (opt.container) {
          //Wrapped in SVG document
          case "svg":
            if (xmlDeclaration) {
              svg += '<?xml version="1.0" standalone="yes"?>' + EOL;
            }
            svg += '<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="' + width + '" height="' + height + '">' + EOL;
            svg += defs + bgrect + modrect;
            svg += '</svg>';
            break;
            
          //Viewbox for responsive use in a browser, thanks to @danioso
          case "svg-viewbox":
            if (xmlDeclaration) {
              svg += '<?xml version="1.0" standalone="yes"?>' + EOL;
            }
            svg += '<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="0 0 ' + width + ' ' + height + '">' + EOL;
            svg += defs + bgrect + modrect;
            svg += '</svg>';
            break;
            
          
          //Wrapped in group element    
          case "g":
            svg += '<g width="' + width + '" height="' + height + '">' + EOL;
            svg += defs + bgrect + modrect;
            svg += '</g>';
            break;
            
          //Without a container
          default:
            svg += (defs + bgrect + modrect).replace(/^\s+/, ""); //Clear indents on each line
            break;
        }
        
        return svg;
      };

      /** Writes QR Code image to a file */
      QRCode.prototype.save = function(file, callback) {
        var data = this.svg();
        if (typeof callback != "function") {
          callback = function(error, result) { };
        }
        try {
          //Package 'fs' is available in node.js but not in a web browser
          var fs = require('fs');
          fs.writeFile(file, data, callback);
        }
        catch (e) {
          //Sorry, 'fs' is not available
          callback(e);
        }
      };
      return QRCode
    })()
    // ---- end vendored: QR encoder ----

    const API = '/api/dsh-gateway'
    const POLL_MS = 3000

    // One stylesheet for the rail/pane split and the editor shell. Everything
    // that must respond to a container width lives here; controls keep coming
    // from the primitives so their look stays the shell's. Two query containers
    // are involved: the page (`dsh-gw`) and the detail pane (`dsh-gw-pane`),
    // because the pane is the box whose width actually decides how many fields
    // fit — a 760px settings column minus the rail. Injected once, keyed so a
    // second mount cannot duplicate it.
    const CSS = `
.dsh-gw-page{width:100%;min-width:0;height:100%;min-height:0;display:flex;overflow:hidden;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.dsh-gw-pagescroll{flex:1;min-height:0;overflow:auto;scrollbar-gutter:stable;--dsh-scrollbar-width:9px;--dsh-scrollbar-thumb-border:2px}
.dsh-gw-pagecontent{max-width:1080px;margin:0 auto;padding:0 clamp(24px,4vw,48px) 48px}
.dsh-gw-pagehead{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;padding-top:calc(28px + var(--dsh-frame-top-clearance,0px));margin-bottom:20px}
.dsh-gw-pagetitle{margin:0;font-size:20px;font-weight:500;line-height:28px}
.dsh-gw-pageintro{margin:4px 0 0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.dsh-gw-root{display:flex;flex-direction:column;gap:14px;width:100%;color:var(--dsw-alias-label-primary);container:dsh-gw/inline-size}
.dsh-gw-status{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 12px;border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-settings-card-fill)}
.dsh-gw-status-copy{display:flex;flex-direction:column;gap:2px;min-width:0}
.dsh-gw-status-title{font-size:13px;line-height:20px}
.dsh-gw-status-sub{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.dsh-gw-spacer{flex:1}
.dsh-gw-body{display:grid;grid-template-columns:196px minmax(0,1fr);gap:18px;align-items:start;min-width:0}
@container dsh-gw (width<=600px){.dsh-gw-body{grid-template-columns:minmax(0,1fr)}}
.dsh-gw-rail{display:flex;flex-direction:column;gap:10px;min-width:0}
.dsh-gw-rail-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.dsh-gw-rail-count{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dsh-gw-rail-new{justify-content:flex-start;width:100%}
.dsh-gw-railitems{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none;min-width:0}
.dsh-gw-railitem{display:grid;grid-template-columns:30px minmax(0,1fr) max-content;align-items:center;gap:10px;width:100%;padding:8px 10px;border:.5px solid transparent;border-radius:var(--dsw-radius-lg);background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;min-width:0}
.dsh-gw-railitem:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-gw-railitem[data-active=true]{border-color:var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1)}
.dsh-gw-railitem:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dsh-gw-railitem-main{display:flex;flex-direction:column;gap:2px;min-width:0}
.dsh-gw-railitem-title{font-size:13px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-gw-railitem-sub{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-gw-railitem-side{display:inline-flex;align-items:center;padding-left:2px}
.dsh-gw-rail-empty{padding:6px 2px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dsh-gw-pane{display:flex;flex-direction:column;gap:12px;min-width:0;container:dsh-gw-pane/inline-size}
.dsh-gw-surface{border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill);overflow:hidden}
.dsh-gw-panehead{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dsh-gw-panehead-main{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}
.dsh-gw-panetitle{font-size:14px;line-height:20px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-gw-panesub{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.dsh-gw-panehead-side{display:inline-flex;align-items:center;gap:10px;flex:none}
.dsh-gw-form{display:flex;flex-direction:column;gap:12px;padding:12px 14px}
.dsh-gw-logo{flex:none;display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:9px;background:var(--dsw-alias-bg-module-platform);color:var(--gw-kind,var(--dsw-alias-label-secondary));font-size:12px;font-weight:500;letter-spacing:.02em;text-transform:uppercase}
.dsh-gw-logo svg{display:block;width:19px;height:19px}
.dsh-gw-logo[data-size=lg]{width:38px;height:38px;border-radius:11px}
.dsh-gw-logo[data-size=lg] svg{width:24px;height:24px}
.dsh-gw-card{border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:10px;padding:12px 14px;min-width:0}
.dsh-gw-card-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap}
.dsh-gw-card-copy{display:flex;flex-direction:column;gap:2px;min-width:0}
.dsh-gw-card-title{font-size:13px;line-height:20px;font-weight:500}
.dsh-gw-card-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.dsh-gw-rows{display:flex;flex-direction:column;min-width:0}
.dsh-gw-rows>*{padding:10px 0;border-bottom:.5px solid var(--dsw-alias-border-l1)}
.dsh-gw-rows>*:first-child{padding-top:0}
.dsh-gw-rows>*:last-child{padding-bottom:0;border-bottom:0}
.dsh-gw-row{display:grid;grid-template-columns:minmax(0,1fr) max-content;align-items:center;gap:16px;min-width:0}
.dsh-gw-row-copy{display:flex;flex-direction:column;gap:3px;min-width:0}
.dsh-gw-row-title{font-size:13px;line-height:20px}
.dsh-gw-row-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.dsh-gw-row-control{display:inline-flex;align-items:center;gap:8px;justify-self:end;min-width:0;max-width:100%}
@container dsh-gw-pane (width<=380px){.dsh-gw-row{grid-template-columns:minmax(0,1fr);gap:8px}.dsh-gw-row-control{justify-self:stretch;width:100%}}
.dsh-gw-switchrow{display:grid;grid-template-columns:minmax(0,1fr) max-content;align-items:center;gap:16px;min-width:0}
.dsh-gw-switchrow-copy{display:flex;flex-direction:column;gap:3px;min-width:0}
.dsh-gw-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 14px;min-width:0}
@container dsh-gw-pane (width<=440px){.dsh-gw-fields{grid-template-columns:minmax(0,1fr)}}
.dsh-gw-field{display:flex;flex-direction:column;gap:5px;min-width:0}
.dsh-gw-field-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.dsh-gw-req{color:var(--dsw-alias-state-error-primary);margin-left:2px}
.dsh-gw-field-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.dsh-gw-seg{align-self:flex-start}
.dsh-gw-mode{grid-auto-columns:1fr;width:100%}
.dsh-gw-selectwrap{position:relative;display:inline-flex;align-items:center;min-width:0;max-width:100%}
.dsh-gw-select{width:100%;height:34px;box-sizing:border-box;padding:0 32px 0 12px;border:0;border-radius:10px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;appearance:none;cursor:pointer;outline:none;text-overflow:ellipsis}
.dsh-gw-select:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.dsh-gw-select:disabled{opacity:.55;cursor:not-allowed}
.dsh-gw-selectwrap>svg{position:absolute;right:9px;pointer-events:none;color:var(--dsw-alias-label-tertiary)}
.dsh-gw-choices{display:flex;flex-direction:column;gap:4px;min-width:0}
.dsh-gw-choice{display:grid;grid-template-columns:minmax(0,1fr);gap:0;padding:7px 0;border-bottom:.5px solid var(--dsw-alias-border-l1);min-width:0}
.dsh-gw-choice:last-child{border-bottom:0}
.dsh-gw-choice-main{display:grid;grid-template-columns:minmax(0,1fr);gap:1px;min-width:0}
.dsh-gw-choice-title{font-size:13px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-gw-choice-path{display:inline-flex;align-items:center;gap:5px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere;min-width:0}
.dsh-gw-choice-path svg{flex:none}
.dsh-gw-choice-stale{color:var(--dsw-alias-state-warn-label)}
.dsh-gw-tiles{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;min-width:0}
@container dsh-gw-pane (width<=380px){.dsh-gw-tiles{grid-template-columns:minmax(0,1fr)}}
.dsh-gw-tile{display:grid;grid-template-columns:34px minmax(0,1fr);align-items:center;gap:12px;padding:12px;border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;text-align:left;cursor:pointer;min-width:0;transition:border-color .16s ease,background .16s ease}
.dsh-gw-tile:hover{border-color:var(--dsw-alias-border-l3);background:var(--dsw-alias-interactive-bg-hover)}
.dsh-gw-tile:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dsh-gw-tile-main{display:flex;flex-direction:column;gap:2px;min-width:0}
.dsh-gw-tile-title{display:flex;align-items:center;gap:6px;font-size:13px;line-height:18px;font-weight:500}
.dsh-gw-tile-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.dsh-gw-qr-panel{display:grid;grid-template-columns:max-content minmax(0,1fr);align-items:center;gap:16px;min-width:0}
@container dsh-gw-pane (width<=400px){.dsh-gw-qr-panel{grid-template-columns:minmax(0,1fr);justify-items:center}}
.dsh-gw-qr-frame{padding:9px;border-radius:var(--dsw-radius-md);background:#fff;box-shadow:var(--dsw-elevation-soft,0 2px 8px rgba(0,0,0,.08))}
.dsh-gw-qr{display:block}
.dsh-gw-qr-modules{fill:#000;shape-rendering:crispEdges}
.dsh-gw-qr-copy{display:flex;flex-direction:column;gap:8px;min-width:0}
.dsh-gw-qr-steps{display:flex;flex-direction:column;gap:5px;margin:0;padding:0;list-style:none;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dsh-gw-qr-steps li{display:flex;align-items:center;gap:7px;min-width:0}
.dsh-gw-qr-step-no{flex:none;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font-size:11px}
.dsh-gw-qr-status{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.dsh-gw-qr-error{color:var(--dsw-alias-state-error-primary)}
.dsh-gw-chips{display:flex;flex-wrap:wrap;gap:8px;min-width:0}
.dsh-gw-chips .dsh-gw-chip{height:32px;padding:0 12px;font-size:13px;border-radius:var(--dsw-radius-md)}
.dsh-gw-chips .dsh-gw-chip:disabled{cursor:not-allowed;opacity:.55}
.dsh-gw-secret{display:flex;align-items:center;gap:8px;min-width:0}
.dsh-gw-secret>.dsh-gw-input{flex:1 1 auto}
.dsh-gw-link{display:inline-flex;align-items:center;gap:4px;font-size:12px;line-height:18px;color:var(--dsw-alias-link,var(--dsw-alias-state-business-primary));text-decoration:none;white-space:nowrap}
.dsh-gw-link:hover{text-decoration:underline}
.dsh-gw-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsh-gw-danger{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 32%,transparent)}
.dsh-gw-danger .dsh-gw-card-title{color:var(--dsw-alias-state-error-primary)}
.dsh-gw-danger-action{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent);color:var(--dsw-alias-state-error-primary)}
.dsh-gw-danger-action:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 60%,transparent)}
.dsh-gw-confirm{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-radius:var(--dsw-radius-md);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 7%,transparent)}
.dsh-gw-confirm strong{font-size:13px;line-height:20px;font-weight:500}
.dsh-gw-note{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dsh-gw-warn{margin:0;display:flex;align-items:flex-start;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-state-warn-label)}
.dsh-gw-warn-strong{color:var(--dsw-alias-state-error-primary)}
.dsh-gw-warn svg{flex:none;margin-top:2px}
.dsh-gw-empty{padding:18px 4px;text-align:center;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
.dsh-gw-flash{display:flex;align-items:center;justify-content:space-between;gap:10px;border-radius:var(--dsw-radius-lg);padding:8px 10px;font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dsh-gw-flash[data-kind=ok]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent);color:var(--dsw-alias-state-success-primary)}
.dsh-gw-flash[data-kind=warn]{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent);color:var(--dsw-alias-state-warn-label)}
.dsh-gw-flash[data-kind=err]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);color:var(--dsw-alias-state-error-primary)}
.dsh-gw-visuallyhidden{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.dsh-gw-root .dsh-gw-input{display:flex;width:100%;box-sizing:border-box}
`
    const CSS_TAG = '@slothtron/dsh-gateway/panel.css'
    if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${CSS_TAG}"]`) === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = '@slothtron/dsh-gateway'
      tag.dataset.pluginCss = CSS_TAG
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    async function api(pathname, options) {
      const res = await fetch(API + pathname, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...(options?.headers ?? {}) },
      })
      if (!res.ok) {
        let message = `HTTP ${res.status}`
        try { message = ((await res.json()).error) ?? message } catch { /* keep status */ }
        throw new Error(message)
      }
      return res.json()
    }

    // -------------------------------------------------- schema / draft model

    const TYPE_DEFAULT = { switch: false, number: 0, segmented: '', text: '', password: '' }
    const isBlank = (value) => value === undefined || value === null || value === ''

    /** Every control of a kind, in render order, tagged with its owning group. */
    function controlsOf(kindDef) {
      const out = []
      for (const group of kindDef?.groups ?? []) {
        for (const control of group.controls ?? []) out.push({ group, control })
      }
      return out
    }

    /** A control's value, falling back to the schema default the sidecar sent. */
    function readControl(config, group, control) {
      const scope = group.path ? (config?.[group.path] ?? {}) : (config ?? {})
      const value = scope[control.name]
      if (value === false || value === 0) return value
      if (!isBlank(value)) return value
      // A null default means "no declared default" (a key the dataclass does not
      // name, e.g. weixin's flat form) — use the type's empty value instead.
      return control.default != null ? control.default : TYPE_DEFAULT[control.type] ?? ''
    }

    /**
     * Seed a draft from the schema. Top-level keys come from the rendered
     * controls only, because octop-gateway refills every unset field from the
     * dataclass default. A nested group (``group_context``) keeps the server's
     * whole object, so per-group overrides and TTLs we do not render survive.
     */
    function seedConfig(kindDef) {
      const config = {}
      for (const group of kindDef?.groups ?? []) {
        if (group.path) {
          const base = { ...(kindDef.defaults?.[group.path] ?? {}) }
          for (const control of group.controls ?? []) {
            base[control.name] = readControl({ [group.path]: base }, group, control)
          }
          config[group.path] = base
        } else {
          for (const control of group.controls ?? []) {
            config[control.name] = readControl(config, group, control)
          }
        }
      }
      return config
    }

    function blankDraft(kindDef) {
      return {
        kind: kindDef?.kind ?? '',
        config: seedConfig(kindDef),
        secrets: {},      // field -> non-empty string = set this value
        secretClear: {},  // field -> true = clear stored value
        // Which workspaces this channel may use. The name is not part of the
        // draft: the host derives it from the platform plus a fresh id.
        workspaceAccess: { mode: 'all', paths: [] },
        sessionPolicy: { compactEnabled: true, compactThresholdPct: 80, archivePrevious: false },
      }
    }

    function draftFromRecord(record, kindDef) {
      const stored = record.config ?? {}
      const config = seedConfig(kindDef)
      // A stored value wins over the schema default. A key the schema no longer
      // declares is dropped here, exactly as octop-gateway would ignore it.
      for (const { group, control } of controlsOf(kindDef)) {
        const from = group.path ? (stored[group.path] ?? {}) : stored
        if (!Object.prototype.hasOwnProperty.call(from, control.name)) continue
        if (group.path) {
          config[group.path] = { ...(config[group.path] ?? {}), [control.name]: from[control.name] }
        } else {
          config[control.name] = from[control.name]
        }
      }
      return {
        kind: record.kind,
        config,
        secrets: {},
        secretClear: {},
        workspaceAccess: {
          mode: record.workspaceAccess?.mode === 'selected' ? 'selected' : 'all',
          paths: [...(record.workspaceAccess?.paths ?? [])].map(String),
        },
        // Normalize as we copy: a record written before the compaction policy
        // existed carries rotation fields, and reading them as "no preference"
        // would silently switch compaction off.
        sessionPolicy: {
          compactEnabled: record.sessionPolicy?.compactEnabled !== false,
          compactThresholdPct: Number(
            record.sessionPolicy?.compactThresholdPct ?? record.sessionPolicy?.contextThresholdPct ?? 80,
          ),
          archivePrevious: Boolean(record.sessionPolicy?.archivePrevious),
        },
      }
    }

    function setControl(draft, group, control, value) {
      if (!group.path) {
        return { ...draft, config: { ...draft.config, [control.name]: value } }
      }
      const nested = { ...(draft.config?.[group.path] ?? {}), [control.name]: value }
      return { ...draft, config: { ...draft.config, [group.path]: nested } }
    }

    /** Server-side fingerprint of everything the editor can edit. */
    function fingerprint(record) {
      const configuredSecrets = Object.entries(record.secrets ?? {})
        .filter(([, info]) => info?.configured)
        .map(([field]) => field)
        .sort()
      return JSON.stringify([
        record.kind, record.label, record.config ?? {},
        record.workspaceAccess ?? { mode: 'all', paths: [] },
        record.sessionPolicy ?? {}, record.enabled, configuredSecrets,
      ])
    }

    function secretsPayload(draft) {
      const payload = {}
      for (const [field, value] of Object.entries(draft.secrets)) {
        if (typeof value === 'string' && value.length > 0) payload[field] = value
      }
      for (const [field, clear] of Object.entries(draft.secretClear)) {
        if (clear && payload[field] === undefined) payload[field] = null
      }
      return payload
    }

    function payloadFrom(draft) {
      return {
        kind: draft.kind,
        config: draft.config,
        secrets: secretsPayload(draft),
        workspaceAccess: {
          mode: draft.workspaceAccess?.mode === 'selected' ? 'selected' : 'all',
          paths: draft.workspaceAccess?.mode === 'selected' ? (draft.workspaceAccess?.paths ?? []) : [],
        },
        sessionPolicy: draft.sessionPolicy,
      }
    }

    /** Fallback mark: the kind's display name reads as an acronym. */
    function glyphOf(kindDef, kind) {
      const source = String(kindDef?.label ?? kind ?? '').replace(/[^0-9a-z]/gi, '')
      return (source || String(kind ?? '')).slice(0, 2) || '?'
    }

    function kindLabelOf(kindDef, kind) {
      return kindDef?.label ?? kind
    }

    /**
     * The platform mark, tinted from the catalogue's `color` and drawn with
     * `currentColor` unless the mark is multicolour. A kind the vendored set
     * does not know about falls back to its acronym, so a catalogue addition
     * renders immediately instead of leaving a hole.
     */
    function KindLogo(props) {
      const { kind, kindDef, size } = props
      const tint = { '--gw-kind': kindDef?.color ?? '' }
      const paths = LOGO_PATHS[kind]
      let mark = null
      if (paths) {
        mark = h('svg', {
          viewBox: LOGO_VIEW_BOX[kind] ?? '0 0 24 24',
          focusable: 'false',
          'aria-hidden': 'true',
        }, paths.map((d, index) => h('path', { key: index, fill: 'currentColor', d })))
      } else if (kind === 'feishu') {
        mark = h('svg', { viewBox: '0 0 24 24', focusable: 'false', 'aria-hidden': 'true' },
          FEISHU_PATHS.map((path, index) => h('path', { key: index, fill: path.fill, d: path.d })))
      }
      return h('span', {
        className: 'dsh-gw-logo',
        style: tint,
        'data-size': size === 'lg' ? 'lg' : undefined,
        'aria-hidden': 'true',
      }, mark ?? glyphOf(kindDef, kind))
    }

    /**
     * One-line workspace summary. The rail has ~170px for it, so the rail asks
     * for the short form; the pane header can afford the full phrase.
     */
    function accessText(record, short) {
      const access = record?.workspaceAccess
      const scoped = access?.mode === 'selected' && (access.paths ?? []).length > 0
      if (!scoped) return '所有工作区'
      return short ? `${access.paths.length} 个工作区` : `指定工作区（${access.paths.length} 个）`
    }

    /** Last path segment, for a one-line label of a directory. */
    function baseName(pathValue) {
      const parts = String(pathValue ?? '').split(/[\\/]/).filter(Boolean)
      return parts.length ? parts[parts.length - 1] : String(pathValue ?? '')
    }

    // ------------------------------------------------------------- fragments
    // ------------------------------------------------------------ scan-to-create

    // Encoding is pure and cheap, but the form re-renders on every keystroke, so
    // a tiny cache keeps it off the hot path without a hook.
    const qrModuleCache = new Map()

    // The polling tick is created once (empty deps) and would close over the
    // first draft it ever saw, so the current draft is mirrored here on render.
    let currentDraft = null

    function qrModules(value) {
      if (qrModuleCache.has(value)) return qrModuleCache.get(value)
      const encoded = new QrCode({ content: String(value), ecl: 'M' })
      const modules = encoded.qrcode.modules.map((row) => row.map(Boolean))
      if (qrModuleCache.size >= 8) qrModuleCache.clear()
      qrModuleCache.set(value, modules)
      return modules
    }

    /**
     * Render one QR as SVG. The colours are fixed black-on-white on purpose: a
     * QR is read by a camera, not by the eye, and an inverted code is rejected
     * by many scanners, so it must not follow the theme.
     */
    function QrCodeSvg(props) {
      const { value, size, label } = props
      const modules = qrModules(value)
      const count = modules.length
      const quiet = 2
      const total = count + quiet * 2
      const path = []
      for (let row = 0; row < count; row += 1) {
        for (let col = 0; col < count; col += 1) {
          if (modules[row][col]) path.push(`M${col + quiet} ${row + quiet}h1v1h-1z`)
        }
      }
      return h('svg', {
        className: 'dsh-gw-qr',
        width: size ?? 180,
        height: size ?? 180,
        viewBox: `0 0 ${total} ${total}`,
        role: 'img',
        'aria-label': label ?? '登录二维码',
      }, h('path', { className: 'dsh-gw-qr-modules', d: path.join('') }))
    }

    /** One line describing a scan session, for the panel's status row. */
    function qrStatusText(qr) {
      if (!qr) return '点「生成二维码」开始'
      switch (qr.status) {
        case 'waiting': return '等待扫码…'
        case 'scanned': return '已扫描，请在手机上确认'
        case 'success': return '已确认，凭据已回填'
        case 'creating': return '已确认，正在创建通道…'
        case 'expired': return qr.message || '二维码已过期，请重新生成'
        case 'unknown': return '会话已失效，请重新生成'
        case 'error': return qr.message || '扫码失败'
        default: return qr.message || String(qr.status)
      }
    }

    /**
     * Apply what a scan handed back. Only names the kind actually declares are
     * accepted, so a catalogue change can never inject an unknown config key.
     */
    function applyQrCredentials(draft, kindDef, result) {
      const known = new Set(controlsOf(kindDef).map(({ control }) => control.name))
      const config = { ...draft.config }
      const secrets = { ...draft.secrets }
      for (const [name, value] of Object.entries(result.fills ?? {})) {
        if (known.has(name) && !isBlank(value)) config[name] = value
      }
      for (const [name, value] of Object.entries(result.secrets ?? {})) {
        if (known.has(name) && !isBlank(value)) secrets[name] = value
      }
      return { ...draft, config, secrets }
    }


    function Field(props) {
      const { label, hint, required, children } = props
      return h('div', { className: 'dsh-gw-field' },
        h('span', { className: 'dsh-gw-field-label' }, label, required ? h('span', { className: 'dsh-gw-req' }, '*') : null),
        children,
        hint ? h('span', { className: 'dsh-gw-field-hint' }, hint) : null,
      )
    }

    function SwitchRow(props) {
      const { title, hint, checked, disabled, label, onChange } = props
      return h('div', { className: 'dsh-gw-switchrow' },
        h('div', { className: 'dsh-gw-switchrow-copy' },
          h('span', { className: 'dsh-gw-row-title' }, title),
          hint ? h('span', { className: 'dsh-gw-row-desc' }, hint) : null,
        ),
        h('div', { className: 'dsh-gw-row-control' },
          h(Switch, { checked: Boolean(checked), disabled: Boolean(disabled), label, onChange })),
      )
    }

    function Card(props) {
      const { title, description, aside, children, kind, className } = props
      return h('section', {
        className: ['dsh-gw-card', kind === 'danger' ? 'dsh-gw-danger' : '', className ?? ''].filter(Boolean).join(' '),
      },
      title || aside
        ? h('div', { className: 'dsh-gw-card-head' },
          h('div', { className: 'dsh-gw-card-copy' },
            title ? h('h3', { className: 'dsh-gw-card-title' }, title) : null,
            description ? h('p', { className: 'dsh-gw-card-desc' }, description) : null),
          aside ?? null)
        : null,
      children)
    }

    /** A labelled row: copy on the left, its one control on the right. */
    function Row(props) {
      const { title, hint, children } = props
      return h('div', { className: 'dsh-gw-row' },
        h('div', { className: 'dsh-gw-row-copy' },
          h('span', { className: 'dsh-gw-row-title' }, title),
          hint ? h('span', { className: 'dsh-gw-row-desc' }, hint) : null),
        h('div', { className: 'dsh-gw-row-control' }, children))
    }

    /**
     * A native select wearing the shell's control row shape: no border, the
     * module background, and one chevron drawn beside it. Native on purpose —
     * it keeps keyboard and screen-reader behaviour the platform already has,
     * which a hand-built dropdown would have to re-earn.
     */
    function Select(props) {
      const { value, options, disabled, label, onChange } = props
      return h('span', { className: 'dsh-gw-selectwrap' },
        h('select', {
          className: 'dsh-gw-select',
          value,
          disabled: Boolean(disabled),
          'aria-label': label,
          onChange: (event) => onChange(event.target.value),
        }, options.map((option) => h('option', {
          key: option.value,
          value: option.value,
          disabled: Boolean(option.disabled),
        }, option.label))),
        h(IconChevronDownOutlineRegular, null))
    }

    /**
     * One channel's live state in words, from the host's `{connected, reason,
     * detail}`. The rail dot, the pane tag and the pane's warning line all read
     * this, so a failed start cannot show up as "still connecting" in one place
     * and red in another.
     */
    function channelState(record, supported) {
      const status = record?.status
        ?? { connected: Boolean(record?.connected), reason: null, detail: null }
      if (!supported) {
        return {
          tone: 'quiet',
          dot: 'error',
          label: '已不再支持',
          hint: '这个平台已经不在当前部署的通道目录里；通道记录保留，只能删除。',
        }
      }
      if (!record?.enabled) {
        return { tone: 'quiet', dot: 'idle', label: '已停用', hint: '停用的通道不会连接平台。' }
      }
      if (status.connected) {
        return { tone: 'success', dot: 'done', label: '连接正常', hint: null }
      }
      if (status.reason === 'error') {
        return {
          tone: 'danger',
          dot: 'error',
          label: '启动失败',
          // The explanation is the actionable sentence alone: the label is
          // already said wherever this is rendered.
          hint: status.detail ? status.detail : '详情见宿主日志。',
        }
      }
      if (status.reason === 'session-expired') {
        return {
          tone: 'warning',
          dot: 'error',
          label: '登录态失效',
          hint: '需要重新扫码登录。',
        }
      }
      if (status.reason === 'unregistered') {
        return {
          tone: 'quiet',
          dot: 'idle',
          label: '未启动',
          hint: '这个通道当前没有交给 sidecar；重新启用或重启 sidecar 会重放它。',
        }
      }
      return {
        tone: 'warning',
        dot: 'ongoing',
        label: '连接中',
        hint: '已经交给 sidecar，正在等平台就绪。',
      }
    }

    /** Status tag: the pane header fact, mirroring the rail item's dot. */
    function StatusTag(props) {
      const { record, supported } = props
      const state = channelState(record, supported)
      const tag = h(Tag, { tone: state.tone }, state.label)
      return state.hint ? h('span', { title: stateTitle(state) }, tag) : tag
    }

    /** The one-line form of a state: "label：why", or just the label. */
    function stateTitle(state) {
      return state.hint ? `${state.label}：${state.hint}` : state.label
    }

    // --------------------------------------------------------------- editor

    /**
     * The platform picker: one tile per kind the catalogue offers. Choosing a
     * platform here is what makes the fields below appear, so a new channel is
     * never a form someone has to guess the shape of.
     */
    function KindPicker(props) {
      const { kinds, onPick } = props
      return h('div', { className: 'dsh-gw-tiles' }, kinds.map((kindDef) => h('button', {
        key: kindDef.kind,
        type: 'button',
        className: 'dsh-gw-tile',
        onClick: () => onPick(kindDef.kind),
      },
      h(KindLogo, { kind: kindDef.kind, kindDef, size: 'lg' }),
      h('span', { className: 'dsh-gw-tile-main' },
        h('span', { className: 'dsh-gw-tile-title' }, kindLabelOf(kindDef, kindDef.kind)),
        kindDef.blurb ? h('span', { className: 'dsh-gw-tile-desc' }, kindDef.blurb) : null))))
    }

    function ChannelEditor(props) {
      const {
        state, record, kindDef, draft, dirty, busy, setDraft,
        onTest, onSave, onCancel, onDelete, onBackToPicker, onSetMode, onStartQr,
      } = props
      const creating = !record
      const locked = Boolean(record?.enabled)
      // Scan-to-create exists only while creating, and only for a kind whose
      // catalogue entry declares it.
      const quick = creating ? kindDef?.quickConfig : null
      const mode = quick ? (props.mode ?? quick.mode) : 'manual'
      const qr = props.qr ?? null
      // `only` means the platform offers no manual entry while creating, so the
      // connection fields never appear until the channel exists and is edited.
      const scanOnly = Boolean(quick?.only)
      const scanning = mode === 'quick' && qr?.status !== 'success'
      // Destructive work asks in place instead of through a page-level dialog:
      // the strip states what goes and what stays, and it belongs to the record
      // it would delete, so switching channels drops it.
      const [confirmDelete, setConfirmDelete] = useState(false)

      useEffect(() => { setConfirmDelete(false) }, [record?.id])

      const setPolicy = (patch) => setDraft((prev) => ({ ...prev, sessionPolicy: { ...prev.sessionPolicy, ...patch } }))
      const setAccess = (patch) => setDraft((prev) => ({
        ...prev, workspaceAccess: { ...(prev.workspaceAccess ?? { mode: 'all', paths: [] }), ...patch },
      }))
      const setControlValue = (group, control, value) => setDraft((prev) => setControl(prev, group, control, value))
      const setSecret = (name, value) => setDraft((prev) => ({
        ...prev, secrets: { ...prev.secrets, [name]: value }, secretClear: { ...prev.secretClear, [name]: false },
      }))
      const toggleClear = (name) => setDraft((prev) => ({
        ...prev, secrets: { ...prev.secrets, [name]: '' }, secretClear: { ...prev.secretClear, [name]: !prev.secretClear[name] },
      }))

      const matches = (scope, relation) =>
        Object.entries(relation ?? {}).every(([key, expected]) => String(scope[key]) === String(expected))

      const scopeOf = (group) => (group.path ? (draft.config?.[group.path] ?? {}) : (draft.config ?? {}))

      const secretSatisfied = (control) => {
        const incoming = draft.secrets?.[control.name]
        if (!isBlank(incoming)) return true
        if (incoming === null || draft.secretClear?.[control.name]) return false
        return Boolean(record?.secrets?.[control.name]?.configured)
      }

      const missingRequired = []
      for (const { group, control } of controlsOf(kindDef)) {
        if (!control.required) continue
        const satisfied = control.secret
          ? secretSatisfied(control)
          : !isBlank(readControl(draft.config, group, control)) && readControl(draft.config, group, control) !== ''
        if (!satisfied) missingRequired.push(control.label ?? control.name)
      }

      const access = draft.workspaceAccess ?? { mode: 'all', paths: [] }
      const workspaces = state?.workspaces ?? []
      const known = new Set(workspaces.map((workspace) => workspace.path))
      const selectedPaths = access.paths ?? []
      const stalePaths = selectedPaths.filter((path) => !known.has(path))
      const accessIncomplete = access.mode === 'selected' && selectedPaths.length === 0
      const togglePath = (path, next) => setAccess({
        paths: next ? [...selectedPaths, path] : selectedPaths.filter((entry) => entry !== path),
      })

      const saveDisabled = Boolean(busy) || !draft.kind || accessIncomplete || (!creating && !dirty)

      function renderControl(group, control) {
        const scope = scopeOf(group)
        const value = readControl(draft.config, group, control)
        const key = `${group.id}:${control.name}`
        if (control.visibleWhen && !matches(scope, control.visibleWhen)) return null
        const disabled = control.disabledWhen
          ? matches(scope, control.disabledWhen)
          : Boolean(control.disabledUnless) && !matches(scope, control.disabledUnless)

        if (control.secret) {
          const configured = Boolean(record?.secrets?.[control.name]?.configured)
          const willClear = Boolean(draft.secretClear?.[control.name])
          const hint = willClear
            ? '将清除已存凭据'
            : (locked
              // The input is disabled while the channel runs (see the file
              // header): say what to do, not that the stored value is kept.
              ? (configured ? '已配置 — 通道运行中不改动，停用后可重填' : '通道运行中不可填写，停用后可填')
              : (configured ? '已配置 — 留空保持不变' : control.hint))
          return h(Field, { key, label: control.label, required: control.required, hint },
            h('div', { className: 'dsh-gw-secret' },
              h(Input, {
                className: 'dsh-gw-input',
                type: 'password',
                'aria-label': control.label,
                autoComplete: 'new-password',
                autoCapitalize: 'none',
                spellCheck: false,
                value: draft.secrets?.[control.name] ?? '',
                disabled: locked,
                placeholder: locked
                  ? '停用后可修改'
                  : (willClear ? '（将清除）' : (configured ? '留空保持不变' : control.placeholder ?? '未配置')),
                onChange: (e) => setSecret(control.name, e.target.value),
              }),
              (configured || willClear) && !locked
                ? h(Button, {
                  size: 'sm',
                  variant: 'outline',
                  onClick: () => toggleClear(control.name),
                }, willClear ? '撤销清除' : '清除')
                : null,
            ),
          )
        }

        if (control.type === 'switch') {
          return h(SwitchRow, {
            key,
            title: control.label,
            hint: control.hint,
            checked: Boolean(value),
            disabled,
            label: control.label,
            onChange: (next) => setControlValue(group, control, next),
          })
        }

        if (control.type === 'segmented') {
          // A value picker, not a tab switch: chips with radio semantics. The
          // segmented-control primitive names a panel per tab, which a plain
          // value picker has none of.
          return h('div', { className: 'dsh-gw-field', key },
            h('span', { className: 'dsh-gw-field-label' }, control.label),
            h('div', { className: 'dsh-gw-chips', role: 'radiogroup', 'aria-label': control.label },
              (control.options ?? []).map((option) => {
                const selected = String(value ?? '') === option.value
                return h(Pill, {
                  key: option.value,
                  className: 'dsh-gw-chip',
                  active: selected,
                  role: 'radio',
                  'aria-checked': String(selected),
                  disabled: Boolean(disabled),
                  onClick: () => setControlValue(group, control, option.value),
                }, option.label)
              }),
            ),
            control.warnWhen && String(value) === control.warnWhen.value
              ? h('span', { className: 'dsh-gw-warn' }, control.warnWhen.text)
              : null,
          )
        }

        if (control.type === 'number') {
          return h(Row, { key, title: control.label, hint: control.hint },
            h(Input, {
              className: 'dsh-gw-input',
              type: 'number',
              'aria-label': control.label,
              min: control.min,
              max: control.max,
              disabled,
              value: value ?? '',
              style: { width: 120 },
              onChange: (e) => {
                const raw = e.target.value
                setControlValue(group, control, raw === '' ? '' : Number(raw))
              },
            }))
        }

        return h(Field, {
          key,
          label: control.label,
          required: control.required,
          hint: control.hint,
        },
        h(Input, {
          className: 'dsh-gw-input',
          'aria-label': control.label,
          disabled,
          value: value ?? '',
          placeholder: control.placeholder ?? (control.required ? '必填' : '可选'),
          onChange: (e) => setControlValue(group, control, e.target.value),
        }),
        )
      }

      const policy = draft.sessionPolicy
      // The compaction engine belongs to the session, not to this deployment at
      // large: a roster deployment composes it inside the session's agent preset.
      // Only a deployment with neither a preset roster nor a host-plane engine
      // has a threshold that could never act.
      const compactionAvailable = state?.compaction?.available !== false
      const compactionScope = state?.compaction?.scope ?? null
      // The channel's own live state, from the same place the rail dot reads it.
      // Only the two states that need the user's hand get a line in the form.
      const statusProblem = record && (record.status?.reason === 'error' || record.status?.reason === 'session-expired')
        ? channelState(record, Boolean(kindDef))
        : null

      const workspaceRows = workspaces.map((workspace) => h('div', { className: 'dsh-gw-choice', key: workspace.id },
        h(Checkbox, {
          checked: selectedPaths.includes(workspace.path),
          label: workspace.title,
          title: workspace.path,
          disabled: Boolean(busy),
          onChange: (next) => togglePath(workspace.path, next),
        }),
        h('span', { className: 'dsh-gw-choice-path', title: workspace.path },
          h(IconFolderOpenOutlineRegular, null), workspace.path)))

      return h('div', { className: 'dsh-gw-form' },
        quick && !scanOnly
          ? h(SegmentedControl, {
            id: 'dsh-gw-create-mode',
            className: 'dsh-gw-seg dsh-gw-mode',
            value: mode,
            label: '配置方式',
            options: [
              { value: 'quick', label: '快捷配置（扫码）' },
              { value: 'manual', label: '手动填写' },
            ],
            onChange: (next) => onSetMode(next),
          })
          : null,

        scanning
          ? h(Card, {
            title: quick.title ?? '快捷配置',
            description: quick.hint,
            aside: h(Button, {
              size: 'sm',
              variant: qr?.url ? 'outline' : 'primary',
              disabled: Boolean(busy) || !kindDef,
              onClick: () => onStartQr(kindDef),
            }, busy === 'qr' ? '生成中…' : (qr?.url ? '重新生成' : '扫码')),
          },
          h('div', { className: 'dsh-gw-qr-panel' },
            qr?.url
              ? h('div', { className: 'dsh-gw-qr-frame' },
                h(QrCodeSvg, { value: qr.url, size: 148, label: `${kindLabelOf(kindDef, draft.kind)} 登录二维码` }))
              : h('span', { className: 'dsh-gw-qr-status' }, busy === 'qr' ? '正在生成二维码…' : '点「扫码」生成二维码'),
            h('div', { className: 'dsh-gw-qr-copy' },
              (quick.steps ?? []).length > 0
                ? h('ol', { className: 'dsh-gw-qr-steps' }, (quick.steps ?? []).map((step, index) =>
                  h('li', { key: `step-${index}` },
                    h('span', { className: 'dsh-gw-qr-step-no' }, String(index + 1)),
                    step)))
                : null,
              h('span', {
                className: `dsh-gw-qr-status${qr?.status === 'expired' || qr?.status === 'unknown' || qr?.status === 'error' ? ' dsh-gw-qr-error' : ''}`,
              }, qrStatusText(qr)),
              quick.pollNote ? h('span', { className: 'dsh-gw-qr-status' }, quick.pollNote) : null)))
          : null,

        // The channel's own state, beside the controls that decide it: the rail
        // dot says something is wrong, this says what.
        statusProblem
          ? h('p', { className: `dsh-gw-warn${statusProblem.tone === 'danger' ? ' dsh-gw-warn-strong' : ''}` },
            h(IconWarningTriangleOutlineRegular, null),
            stateTitle(statusProblem))
          : null,

        ...[
          ...(kindDef?.groups ?? []).map((group) => {
            // While scanning, the connection fields come from the platform; they
            // appear the moment the scan hands its credentials back.
            if (group.id === 'connection' && creating && (scanOnly || scanning)) return null
            const rendered = (group.controls ?? []).map((control) => renderControl(group, control)).filter(Boolean)
            if (rendered.length === 0) return null
            const isGrid = group.id === 'connection'
            return {
              // The catalogue places its own groups (order: 10 connection,
              // 30 group policy, 40 display); one without an order trails them.
              order: group.order ?? 100,
              node: h(Card, {
                key: group.id,
                title: group.title,
                description: group.description,
                aside: group.id === 'connection' && kindDef.credentialUrl
                  ? h('a', {
                    className: 'dsh-gw-link',
                    href: kindDef.credentialUrl,
                    target: '_blank',
                    rel: 'noreferrer noopener',
                  }, '前往获取凭据', h(IconRightUpOutlineRegular, null))
                  : null,
              },
              // A platform-specific caveat the catalogue attaches to this kind.
              group.notice
                ? h('p', { className: 'dsh-gw-warn' }, h(IconWarningTriangleOutlineRegular, null), group.notice)
                : null,
              h('div', { className: isGrid ? 'dsh-gw-fields' : 'dsh-gw-rows' }, rendered)),
            }
          }),
          // Workspace access and the session policy share one card: they answer
          // one question — where this channel's conversations live. It is
          // host-side config, so it is declared here (not in channels.json) and
          // placed between the catalogue's groups by its order.
          {
            order: 20,
            node: h(Card, { key: 'sessions', title: '工作区与会话', description: '这个通道的会话建在哪个工作区、上下文怎么压缩。' },
            h('div', { className: 'dsh-gw-rows' },
              h(Row, {
                title: '工作区访问范围',
                hint: access.mode === 'selected'
                  ? '会话默认落在第一个选中的工作区；IM 里 /workspace 只能切换到这个列表内的工作区。'
                  : '这个通道可以使用所有已配置的工作区；会话默认落在「未分组」。',
              },
              h(Select, {
                value: access.mode,
                label: '工作区访问范围',
                options: [
                  { value: 'all', label: '所有工作区' },
                  { value: 'selected', label: '指定工作区', disabled: workspaces.length === 0 },
                ],
                onChange: (next) => setAccess({ mode: next }),
              })),

              access.mode === 'selected'
                ? h('div', { className: 'dsh-gw-choices' },
                  workspaces.length === 0
                    ? h('p', { className: 'dsh-gw-warn' },
                      h(IconWarningTriangleOutlineRegular, null),
                      '还没有已注册的工作区，先在 DSH 侧边栏创建一个再回来选择。')
                    : workspaceRows,
                  stalePaths.map((path) => h('div', { className: 'dsh-gw-row', key: `stale:${path}` },
                    h('div', { className: 'dsh-gw-row-copy' },
                      h('span', { className: 'dsh-gw-row-title' }, baseName(path) || path),
                      h('span', { className: 'dsh-gw-row-desc dsh-gw-choice-stale' },
                        `${path} — 已不在已注册的工作区里`)),
                    h('div', { className: 'dsh-gw-row-control' },
                      h(Button, {
                        size: 'sm',
                        variant: 'ghost',
                        disabled: Boolean(busy),
                        onClick: () => togglePath(path, false),
                      }, '移除')))))
                : null,

              h(SwitchRow, {
                title: '上下文压缩',
                hint: '水位超过阈值后，由宿主就地压缩历史（同一会话继续，不换新会话）',
                checked: Boolean(policy.compactEnabled),
                disabled: !compactionAvailable,
                label: '上下文压缩',
                onChange: (next) => setPolicy({ compactEnabled: next }),
              }),

              policy.compactEnabled
                ? h(Row, { title: '压缩阈值（%）', hint: '保留多少、怎么摘要由宿主的压缩策略决定' },
                  h(Input, {
                    className: 'dsh-gw-input',
                    type: 'number',
                    'aria-label': '压缩阈值（%）',
                    min: 5,
                    max: 100,
                    style: { width: 120 },
                    disabled: !compactionAvailable,
                    value: policy.compactThresholdPct,
                    onChange: (e) => setPolicy({ compactThresholdPct: Number(e.target.value) }),
                  }))
                : null,
            ),
            !compactionAvailable
              ? h('p', { className: 'dsh-gw-warn' },
                h(IconWarningTriangleOutlineRegular, null),
                '这个部署没有装配压缩服务（宿主平面和 agent preset 里都没有），本通道的压缩设置不会生效。')
              : compactionScope === 'agent-preset'
                ? h('p', { className: 'dsh-gw-note' },
                  '压缩服务由会话的 agent preset 提供：每个 IM 会话按自己用的 preset 解析，阈值只管「什么时候压」。')
                : null,
            h('p', { className: 'dsh-gw-note' },
              'IM 里发 /compact 可立即压缩，/new 可手动开启新会话。'),
            state?.agentPreset
              ? h('p', { className: 'dsh-gw-note' },
                `会话由部署默认的 agent preset「${state.agentPreset.id}」组成（与 GUI 新会话同一套工具、技能与压缩服务）。`)
              : null,
          ) },
        ].filter((card) => card !== null).sort((a, b) => a.order - b.order).map((card) => card.node),

        record
          ? h(Card, {
            kind: 'danger',
            title: '删除通道',
            description: '移除这个通道的连接与凭据；已经路由过的会话仍然留在原来的工作区里。',
            aside: h(Button, {
              className: 'dsh-gw-danger-action',
              size: 'sm',
              variant: 'outline',
              icon: h(IconTrashOutlineRegular, null),
              disabled: Boolean(busy),
              onClick: () => setConfirmDelete(true),
            }, '删除通道'),
          },
          confirmDelete
            ? h('div', { className: 'dsh-gw-confirm', role: 'alertdialog', 'aria-label': '确认删除通道' },
              h('strong', null, `删除「${record.label}」？`),
              h('p', { className: 'dsh-gw-note' },
                '这条通道的连接配置与已保存的凭据会被删除；已经路由过的会话仍然留在原来的工作区里，平台侧的应用不会被动到。'),
              h('div', { className: 'dsh-gw-actions' },
                h(Button, { size: 'sm', variant: 'ghost', disabled: Boolean(busy), onClick: () => setConfirmDelete(false) }, '保留'),
                h(Button, {
                  className: 'dsh-gw-danger-action',
                  size: 'sm',
                  variant: 'outline',
                  disabled: Boolean(busy),
                  onClick: onDelete,
                }, busy === 'delete' ? '删除中…' : '确认删除')))
            : null)
          : null,

        missingRequired.length > 0 || accessIncomplete
          ? h('p', { className: 'dsh-gw-warn' },
            h(IconWarningTriangleOutlineRegular, null),
            [
              missingRequired.length > 0 ? `还需填写：${missingRequired.join('、')}` : null,
              accessIncomplete ? '「指定工作区」需要至少选择一个工作区' : null,
            ].filter(Boolean).join('；'))
          : null,

        h('div', { className: 'dsh-gw-actions' },
          h(Button, { size: 'sm', variant: 'outline', disabled: Boolean(busy) || !draft.kind, onClick: onTest },
            busy === 'test' ? '测试中…' : '测试连接'),
          creating
            ? h(Button, { size: 'sm', variant: 'ghost', disabled: Boolean(busy), onClick: onBackToPicker }, '换平台')
            : null,
          h('span', { className: 'dsh-gw-spacer' }),
          h(Button, { size: 'sm', variant: 'ghost', disabled: Boolean(busy), onClick: onCancel }, '取消'),
          h(Button, {
            size: 'sm',
            variant: 'primary',
            disabled: saveDisabled,
            onClick: onSave,
          }, busy === 'save' ? '保存中…' : (creating ? '创建' : (dirty ? '保存' : '无改动'))),
        ),
      )
    }


    // ------------------------------------------------------------ page

    function OctopBridgeSettings() {
      const [snapshot, setSnapshot] = useState(null)
      // null = nothing selected | {type:'new', kind:'', ...} = platform picker |
      // {type:'new', kind, mode, qr} = creating | {type:'edit', id} = editing.
      const [open, setOpen] = useState(null)
      const [draft, setDraft] = useState(null)
      const [dirty, setDirty] = useState(false)
      const [busy, setBusy] = useState(null)
      const [flash, setFlash] = useState(null)
      const [loadError, setLoadError] = useState(null)
      // Bumping this re-runs the polling effect, which is how "重新读取" retries.
      const [reloadKey, setReloadKey] = useState(0)
      const flashTimer = useRef(null)
      const baselineFpRef = useRef('')
      const dirtyRef = useRef(false)
      const openRef = useRef(null)

      useEffect(() => { dirtyRef.current = dirty }, [dirty])
      useEffect(() => { openRef.current = open }, [open])
      useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current) }, [])

      const showFlash = useCallback((kind, text) => {
        setFlash({ kind, text })
        if (flashTimer.current) clearTimeout(flashTimer.current)
        flashTimer.current = setTimeout(() => setFlash(null), 6000)
      }, [])

      const kindDefOf = useCallback((state, kind) => (state?.kinds ?? []).find((entry) => entry.kind === kind), [])

      const fillEditor = useCallback((record, state) => {
        setOpen({ type: 'edit', id: record.id })
        setDraft(draftFromRecord(record, kindDefOf(state, record.kind)))
        baselineFpRef.current = fingerprint(record)
        setDirty(false)
        setFlash(null)
      }, [kindDefOf])

      const updateDraft = useCallback((updater) => {
        setDraft((prev) => (prev ? updater(prev) : prev))
        setDirty(true)
      }, [])

      /** Abandon any live scan session; the sidecar must not keep polling it. */
      const discardQr = useCallback(() => {
        const taskId = openRef.current?.qr?.taskId
        if (taskId) api(`/qr/${taskId}`, { method: 'DELETE' }).catch(() => {})
      }, [])

      const closeEditor = useCallback(() => {
        discardQr()
        setOpen(null); setDraft(null); setDirty(false)
      }, [discardQr])

      /** Start a create: the platform is picked first, then its fields appear. */
      const openPicker = useCallback(() => {
        discardQr()
        setOpen({ type: 'new', kind: '', mode: null, qr: null })
        setDraft(null)
        baselineFpRef.current = ''
        setDirty(false)
        setFlash(null)
      }, [discardQr])

      const chooseKind = (kind) => {
        const kindDef = kindDefOf(snapshot, kind)
        discardQr()
        // A kind with a scan flow opens on it, mirroring what the platform
        // actually supports; a kind without one opens on manual entry.
        setOpen({ type: 'new', kind, mode: kindDef?.quickConfig ? 'quick' : 'manual', qr: null })
        setDraft(blankDraft(kindDef))
        baselineFpRef.current = ''
        setDirty(false)
        setFlash(null)
      }

      // Polling loop: never touches a dirty draft (rule 3). Clean editors refill
      // only on a server fingerprint change (external edit). One coalesced timer
      // and one in-flight request at a time, so a slow host cannot stack ticks.
      useEffect(() => {
        let alive = true
        let timer
        let inFlight = false
        const schedule = (delay) => {
          if (!alive) return
          if (timer !== undefined) clearTimeout(timer)
          timer = setTimeout(() => {
            timer = undefined
            void tick().then(() => schedule(POLL_MS))
          }, delay)
        }
        const tick = async () => {
          if (inFlight) return
          inFlight = true
          try {
            const state = await api('/state')
            if (!alive) return
            setLoadError(null)
            setSnapshot(state)
            const live = openRef.current
            if (live?.type === 'new' && live.mode === 'quick' && live.qr?.taskId
                && (live.qr.status === 'waiting' || live.qr.status === 'scanned')) {
              try {
                const scanned = await api(`/qr/${live.qr.taskId}`)
                if (scanned.status === 'success' && scanned.fills) {
                  const scannedKind = kindDefOf(state, live.qr.kind)
                  const merged = currentDraft ? applyQrCredentials(currentDraft, scannedKind, scanned) : null
                  if (scannedKind?.quickConfig?.autoCreate && merged) {
                    // The scan IS the creation: no second confirmation step. The
                    // name comes from the host (platform label + a fresh id), so
                    // it is read back off the created record.
                    setOpen((prev) => (prev?.qr?.taskId === live.qr.taskId
                      ? { ...prev, qr: { ...prev.qr, status: 'creating', message: null } }
                      : prev))
                    try {
                      const created = await api('/channels', {
                        method: 'POST',
                        body: JSON.stringify(payloadFrom(merged)),
                      })
                      const fresh = await api('/state')
                      setSnapshot(fresh)
                      const record = (fresh.channels ?? []).find((c) => c.id === created.id)
                      if (record) fillEditor(record, fresh)
                      // Scanning an account that is already configured updates
                      // that channel instead of adding a second poller for the
                      // same login; say which of the two happened.
                      showFlash('ok', created.updated
                        ? `这个账号已经配置过：已更新通道「${record?.label ?? '已更新'}」的凭据`
                        : `已通过扫码创建通道「${record?.label ?? '已创建'}」`)
                    } catch (error) {
                      // Leave the panel usable so a re-scan can be tried.
                      setOpen((prev) => (prev?.qr?.taskId === live.qr.taskId
                        ? { ...prev, qr: { ...prev.qr, status: 'error', message: `创建失败：${error?.message ?? error}` } }
                        : prev))
                    }
                  } else {
                    setDraft((prev) => (prev ? merged ?? applyQrCredentials(prev, scannedKind, scanned) : prev))
                    setDirty(true)
                    setOpen((prev) => (prev?.qr?.taskId === live.qr.taskId
                      ? { ...prev, mode: 'manual', qr: { ...prev.qr, status: 'success' } }
                      : prev))
                    showFlash('ok', '已获取应用凭据，确认无误后点「创建」')
                  }
                } else if (scanned.status !== live.qr.status || (scanned.url && scanned.url !== live.qr.url)) {
                  setOpen((prev) => (prev?.qr?.taskId === live.qr.taskId
                    ? { ...prev, qr: { ...prev.qr, status: scanned.status, url: scanned.url ?? prev.qr.url, message: scanned.message } }
                    : prev))
                }
              } catch { /* keep polling; the /state read already succeeded */ }
            }
            if (openRef.current?.type === 'edit' && !dirtyRef.current) {
              const fresh = (state.channels ?? []).find((c) => c.id === openRef.current.id)
              if (fresh) {
                const fp = fingerprint(fresh)
                if (fp !== baselineFpRef.current) {
                  setDraft(draftFromRecord(fresh, kindDefOf(state, fresh.kind)))
                  baselineFpRef.current = fp
                }
              }
            }
          } catch (error) {
            if (alive) setLoadError(String(error?.message ?? error))
          } finally {
            inFlight = false
          }
        }
        void tick().then(() => schedule(POLL_MS))
        return () => {
          alive = false
          if (timer !== undefined) clearTimeout(timer)
        }
      }, [kindDefOf, reloadKey])

      const runBusy = async (key, fn) => {
        if (busy) return undefined
        setBusy(key)
        try { return await fn() } finally { setBusy(null) }
      }

      const onSave = () => runBusy('save', async () => {
        try {
          const body = { ...payloadFrom(draft) }
          if (open.type === 'edit') body.id = open.id
          const result = await api('/channels', { method: 'POST', body: JSON.stringify(body) })
          const state = await api('/state')
          setSnapshot(state)
          const saved = (state.channels ?? []).find((c) => c.id === result.id)
          if (saved) fillEditor(saved, state)
          if (result.startError) {
            // The config is stored; the platform refused the connection. Keep the
            // two facts apart so nobody goes looking for a lost configuration.
            showFlash('err', `已保存，但启动失败：${result.startError}`)
            return
          }
          showFlash('ok', open.type === 'edit'
            ? '已保存'
            : result.updated
              // Saving a new channel for an account that is already configured
              // lands on that channel: two of them would poll one login.
              ? `这个账号已经配置过：已更新通道「${saved?.label ?? ''}」`
              : `通道「${saved?.label ?? ''}」已创建，连接建立中`)
        } catch (error) {
          showFlash('err', `保存失败：${error?.message ?? error}`)
        }
      })

      const onTest = () => runBusy('test', async () => {
        try {
          const body = { ...payloadFrom(draft) }
          if (open.type === 'edit') body.channelId = open.id
          const result = await api('/channels/test', { method: 'POST', body: JSON.stringify(body) })
          if (result.connected) showFlash('ok', '连接成功：已经等到平台的就绪事件')
          // On failure the host hands back a sentence, not a stack: it is the
          // platform's complaint with a next step in front of it.
          else showFlash('err', `连接失败：${result.detail ?? '未在超时内就绪'}`)
        } catch (error) {
          showFlash('err', `测试失败：${error?.message ?? error}`)
        }
      })

      const onToggle = (record) => runBusy(`toggle:${record.id}`, async () => {
        try {
          const result = await api(`/channels/${record.id}/toggle`, {
            method: 'POST', body: JSON.stringify({ enabled: !record.enabled }),
          })
          const state = await api('/state')
          setSnapshot(state)
          // The switch changes what the editor is allowed to edit, so it is easy
          // to hit while an editor is open: never let it clobber staged edits.
          const fresh = (state.channels ?? []).find((c) => c.id === record.id)
          if (fresh && !dirtyRef.current && openRef.current?.type === 'edit' && openRef.current.id === fresh.id) {
            fillEditor(fresh, state)
          }
          // The switch flipped and the start did not: the red tag and the pane's
          // warning line carry the reason, this line says the toggle itself held.
          if (result.startError) {
            showFlash('err', record.enabled
              ? `已停用，但注销失败：${result.startError}`
              : `已启用，但启动失败：${result.startError}`)
          }
        } catch (error) {
          showFlash('err', `切换失败：${error?.message ?? error}`)
        }
      })

      // No window.confirm: the editor owns an in-place confirmation strip, so
      // the deletion cannot run without the user having seen what it says.
      const onDelete = () => runBusy('delete', async () => {
        try {
          await api(`/channels/${open.id}`, { method: 'DELETE' })
          closeEditor()
          setSnapshot(await api('/state'))
          showFlash('ok', '通道已删除；历史会话保留在工作区里')
        } catch (error) {
          showFlash('err', `删除失败：${error?.message ?? error}`)
        }
      })

      const onSetMode = (next) => {
        if (openRef.current?.qr?.taskId && next === 'manual') discardQr()
        setOpen((prev) => (prev
          ? { ...prev, mode: next, qr: next === 'manual' ? null : prev.qr }
          : prev))
      }

      const onStartQr = (kindDef) => runBusy('qr', async () => {
        discardQr()
        try {
          const session = await api('/qr', { method: 'POST', body: JSON.stringify({ kind: kindDef.kind }) })
          setOpen((prev) => (prev
            ? {
              ...prev,
              mode: 'quick',
              qr: {
                kind: kindDef.kind,
                taskId: session.task_id,
                url: session.url,
                status: 'waiting',
                message: null,
                expiresInSec: session.expiresInSec,
              },
            }
            : prev))
          setFlash(null)
        } catch (error) {
          showFlash('err', `启动扫码失败：${error?.message ?? error}`)
        }
      })

      const onRestart = () => runBusy('restart', async () => {
        try {
          await api('/sidecar/restart', { method: 'POST' })
          showFlash('ok', 'sidecar 已重启')
        } catch (error) {
          showFlash('err', `重启失败：${error?.message ?? error}`)
        }
      })

      const onBootstrapRuntime = () => runBusy('runtime', async () => {
        try {
          await api('/runtime/bootstrap', { method: 'POST' })
          showFlash('ok', '已开始初始化 Python 运行时（首次安装可能需要一两分钟）')
        } catch (error) {
          showFlash('err', `初始化失败：${error?.message ?? error}`)
        }
      })

      const sidecar = snapshot?.sidecar
      const runtime = snapshot?.runtime
      const channels = snapshot?.channels ?? []
      const kinds = snapshot?.kinds ?? []
      const drift = snapshot?.drift ?? []
      const kindsReady = kinds.length > 0
      const supportedLabels = kinds.map((kind) => kind.label ?? kind.kind).join(' / ')
      const enabledCount = channels.filter((c) => c.enabled).length
      const runtimeLabel = (() => {
        if (!runtime) return null
        const kindText = { explicit: '指定解释器', 'package-venv': '包内 .venv', system: '系统解释器', managed: '托管 venv' }[runtime.kind]
          ?? (runtime.phase === 'idle' || runtime.phase === 'probing' ? '探测中' : '未就绪')
        // The running sidecar's version is already on the line above; the probe's
        // version only adds something when it DIFFERS — that means the venv was
        // upgraded while the process still holds the old library.
        const installed = runtime.sdk && runtime.sdk !== sidecar?.gatewayVersion
          ? `octop-gateway ${runtime.sdk}`
          : null
        const versions = [runtime.python ? `Python ${runtime.python}` : null, installed]
          .filter(Boolean).join(' · ')
        const head = `运行时：${kindText}${versions ? ` · ${versions}` : ''}`
        return runtime.lastError ? `${head} — ${String(runtime.lastError).split('\n')[0]}` : head
      })()

      currentDraft = draft
      // A deployment with no channels yet has nothing to select, so it opens on
      // the platform picker instead of an empty pane.
      const view = open ?? (snapshot && channels.length === 0 ? { type: 'new', kind: '' } : null)
      const creating = view?.type === 'new'
      const editorRecord = view?.type === 'edit' ? channels.find((c) => c.id === view.id) ?? null : null
      const viewKind = creating ? (view.kind || draft?.kind || '') : (editorRecord?.kind ?? '')
      const viewKindDef = viewKind ? kindDefOf(snapshot, viewKind) : null
      const showPicker = Boolean(creating && !view.kind)
      const supported = Boolean(viewKindDef)

      const paneHead = creating
        ? h('div', { className: 'dsh-gw-panehead' },
          showPicker ? null : h(KindLogo, { kind: viewKind, kindDef: viewKindDef }),
          h('div', { className: 'dsh-gw-panehead-main' },
            h('span', { className: 'dsh-gw-panetitle' }, showPicker ? '新建通道' : `新建${kindLabelOf(viewKindDef, viewKind)}通道`),
            h('span', { className: 'dsh-gw-panesub' }, showPicker
              ? '选择这个通道接收消息的平台；选择后再配置凭据、工作区访问范围和群聊策略。'
              : (viewKindDef?.quickConfig?.only
                ? '扫码确认后自动创建，无需手填字段；凭据只进 DSH 凭据库。'
                : viewKindDef?.quickConfig
                  // Scan is one of two ways in, not the only one: saying "填写连接配置" here
                  // would describe the manual tab while the pane opens on the scan card.
                  ? '扫码可一键取回凭据，也可以手动填写；凭据只进 DSH 凭据库。'
                  : '填写连接配置后创建；凭据只进 DSH 凭据库。'))))
        : editorRecord
          ? h('div', { className: 'dsh-gw-panehead' },
            h(KindLogo, { kind: editorRecord.kind, kindDef: viewKindDef }),
            h('div', { className: 'dsh-gw-panehead-main' },
              h('span', { className: 'dsh-gw-panetitle' }, editorRecord.label),
              h('span', { className: 'dsh-gw-panesub' },
                // The title already starts with the platform name (`微信-0ed969`
                // is derived that way), so repeating it here only adds noise.
                [editorRecord.shortId ? `ID ${editorRecord.shortId}` : null,
                  accessText(editorRecord)].filter(Boolean).join(' · '))),
            h('div', { className: 'dsh-gw-panehead-side' },
              h(StatusTag, { record: editorRecord, supported }),
              h(Switch, {
                checked: Boolean(editorRecord.enabled),
                disabled: Boolean(busy) || !supported,
                label: editorRecord.enabled ? `停用 ${editorRecord.label}` : `启用 ${editorRecord.label}`,
                onChange: () => onToggle(editorRecord),
              })))
          : null

      const paneBody = !view
        ? h('div', { className: 'dsh-gw-empty' }, '在左侧选择一个通道查看和修改配置，或点「新建通道」。')
        : showPicker
          ? h('div', { className: 'dsh-gw-form' }, h(KindPicker, { kinds, onPick: chooseKind }))
          : creating
            ? (draft
              ? h(ChannelEditor, {
                state: snapshot, record: null, kindDef: viewKindDef, draft, dirty, busy,
                setDraft: updateDraft, mode: view.mode, qr: view.qr,
                onTest, onSave, onCancel: closeEditor, onDelete: null,
                onBackToPicker: openPicker, onSetMode, onStartQr,
              })
              : null)
            : editorRecord
              ? (supported
                ? (draft
                  ? h(ChannelEditor, {
                    state: snapshot, record: editorRecord, kindDef: viewKindDef, draft, dirty, busy,
                    setDraft: updateDraft, onTest, onSave, onCancel: closeEditor, onDelete, onSetMode, onStartQr,
                  })
                  : null)
                : h('div', { className: 'dsh-gw-form' },
                  h('p', { className: 'dsh-gw-warn' },
                    h(IconWarningTriangleOutlineRegular, null),
                    `该通道类型（${editorRecord.kind}）已不在当前支持范围内（${supportedLabels}）；配置已保留，可删除本通道。`),
                  h('div', { className: 'dsh-gw-actions' },
                    h(Button, {
                      size: 'sm',
                      variant: 'outline',
                      icon: h(IconTrashOutlineRegular, null),
                      disabled: Boolean(busy),
                      onClick: onDelete,
                    }, busy === 'delete' ? '删除中…' : '删除通道'),
                    h('span', { className: 'dsh-gw-spacer' }),
                    h(Button, { size: 'sm', variant: 'ghost', disabled: Boolean(busy), onClick: closeEditor }, '取消'))))
              : null

      return h('div', { className: 'dsh-gw-root' },
        h('div', { className: 'dsh-gw-status' },
          h(StateDot, { state: sidecar?.running ? 'done' : 'error' }),
          h('div', { className: 'dsh-gw-status-copy' },
            h('span', { className: 'dsh-gw-status-title' },
              sidecar?.running
                ? `sidecar 运行中${sidecar.gatewayVersion ? ` · octop-gateway ${sidecar.gatewayVersion}` : ''}`
                : `sidecar 未运行${sidecar?.lastError ? ` — ${sidecar.lastError}` : ''}`,
            ),
            runtimeLabel ? h('span', { className: 'dsh-gw-status-sub' }, runtimeLabel) : null,
            kindsReady ? h('span', { className: 'dsh-gw-status-sub' }, `支持通道：${supportedLabels}`) : null,
          ),
          h('span', { className: 'dsh-gw-spacer' }),
          h(Button, {
            size: 'sm',
            variant: 'outline',
            icon: h(IconRefreshOutlineRegular, null),
            disabled: Boolean(busy),
            title: '重新探测解释器；托管 venv 会重建并重装 octop-gateway',
            onClick: onBootstrapRuntime,
          }, busy === 'runtime' ? '重建中…' : '重建运行时'),
          h(Button, {
            size: 'sm',
            variant: 'ghost',
            icon: h(IconRefreshOutlineRegular, null),
            disabled: Boolean(busy),
            title: '只重启 Python sidecar 进程，不动运行时',
            onClick: onRestart,
          }, busy === 'restart' ? '重启中…' : '重启 sidecar'),
        ),

        flash
          ? h('div', { className: 'dsh-gw-flash', 'data-kind': flash.kind, role: 'status', 'aria-live': 'polite' }, flash.text)
          : null,
        loadError
          ? h('div', { className: 'dsh-gw-flash', 'data-kind': 'err', role: 'alert' },
            h('span', null, `状态获取失败：${loadError}`),
            h(Button, {
              size: 'sm',
              variant: 'outline',
              disabled: Boolean(busy),
              onClick: () => setReloadKey((key) => key + 1),
            }, '重新读取'))
          : null,
        drift.length > 0
          ? h('div', { className: 'dsh-gw-flash', 'data-kind': 'warn' },
            `通道字段与已装 octop-gateway 不一致：${drift.join('；')}`)
          : null,
        !kindsReady && snapshot
          ? h('div', { className: 'dsh-gw-flash', 'data-kind': 'err' },
            '通道类型清单为空：sidecar 未就绪或未安装 octop-gateway——可点「重建运行时」自动安装')
          : null,

        h('div', { className: 'dsh-gw-body' },
          h('div', { className: 'dsh-gw-rail' },
            h('div', { className: 'dsh-gw-rail-head' },
              h('span', { className: 'dsh-gw-rail-count' },
                snapshot ? `通道 ${channels.length} · 启用 ${enabledCount}` : '加载中…')),
            h(Button, {
              className: 'dsh-gw-rail-new',
              size: 'sm',
              variant: 'outline',
              icon: h(IconPlusOutlineRegular, null),
              disabled: !kindsReady || Boolean(busy) || showPicker,
              onClick: openPicker,
            }, '新建通道'),
            h('ul', { className: 'dsh-gw-railitems' }, channels.map((record) => {
              const kindDef = kindDefOf(snapshot, record.kind)
              const isSupported = Boolean(kindDef)
              const isActive = view?.type === 'edit' && view.id === record.id
              // The dot cannot say why; the tooltip can, and it is the only place
              // a reason reaches the user without opening the channel.
              const state = channelState(record, isSupported)
              return h('li', { key: record.id },
                h('button', {
                  type: 'button',
                  className: 'dsh-gw-railitem',
                  'data-active': String(isActive),
                  'aria-current': isActive ? 'true' : undefined,
                  onClick: () => (isActive ? closeEditor() : fillEditor(record, snapshot)),
                },
                h(KindLogo, { kind: record.kind, kindDef }),
                h('span', { className: 'dsh-gw-railitem-main' },
                  h('span', { className: 'dsh-gw-railitem-title', title: record.label }, record.label),
                  h('span', {
                    className: 'dsh-gw-railitem-sub',
                    // The rail truncates; the tooltip keeps the full line reachable.
                    title: `${kindLabelOf(kindDef, record.kind)} · ${accessText(record)}`,
                  },
                  `${kindLabelOf(kindDef, record.kind)} · ${accessText(record, true)}`)),
                h('span', {
                  className: 'dsh-gw-railitem-side',
                  title: stateTitle(state),
                },
                h(StateDot, { state: state.dot }))))
            })),
            snapshot && channels.length === 0
              ? h('p', { className: 'dsh-gw-rail-empty' }, '还没有通道。')
              : null,
            !snapshot ? h('p', { className: 'dsh-gw-rail-empty' }, '加载中…') : null,
          ),

          h('div', { className: 'dsh-gw-pane' },
            h('div', { className: 'dsh-gw-surface' },
              paneHead,
              paneBody))),
      )
    }

    // ------------------------------------------------------------ the panel
    //
    // The entry is a first-class sidebar row, not a settings section: the row is
    // a `sidebar.panellist` list entry and the page it opens is the `main` entry
    // with the same key — that is the pair the sidebar switches between (see the
    // shell's own plugin and schedule panels). Because both registrations belong
    // to THIS plugin's client half, disabling the plugin removes the row with it;
    // nothing is hardcoded into the host navigation.

    const PANEL_ID = 'dsh-gateway'
    const PANEL_LABEL = 'IM 网关'

    /** The sidebar row's glyph: the shell renders it inside its own button. */
    function ImGatewayGlyph(props) {
      return h(IconApiOutlineRegular, { size: props?.size })
    }

    /**
     * The page shell the sidebar renders into the centre column. It follows the
     * shell's own page conventions — full-height flex, one inner scroll area, a
     * centred content column, and the top clearance the desktop frame reserves —
     * because outside the settings modal nothing else supplies them.
     */
    function ImGatewayPage() {
      return h('section', {
        className: 'dsh-gw-page',
        'data-plugin-panel': true,
        'aria-label': PANEL_LABEL,
      },
      h('div', { className: 'dsh-gw-pagescroll' },
        h('div', { className: 'dsh-gw-pagecontent' },
          h('header', { className: 'dsh-gw-pagehead', 'data-window-drag': true },
            h('div', null,
              h('h1', { className: 'dsh-gw-pagetitle' }, PANEL_LABEL),
              h('p', { className: 'dsh-gw-pageintro' },
                '把外部聊天工具接进 DSH 会话；通道凭据只进 DSH 凭据库。'))),
          h(OctopBridgeSettings, null))))
    }

    /**
     * One bad render must not take the whole page with it: a class boundary
     * catches it, says so, and offers a retry that remounts the page. Declared
     * once and registered directly — a component type created during render would
     * remount (and lose) the page on every pass.
     */
    class PanelErrorBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }

      static getDerivedStateFromError() {
        return { failed: true }
      }

      componentDidCatch(error) {
        // The host owns logging; this at least puts the message in the console
        // next to the crash instead of only in React's internal report.
        if (typeof console !== 'undefined') console.error('dsh-gateway: panel render failed', error)
      }

      render() {
        if (this.state.failed) {
          return h('div', { className: 'dsh-gw-page', role: 'alert' },
            h('div', { className: 'dsh-gw-pagescroll' },
              h('div', { className: 'dsh-gw-pagecontent' },
                h('header', { className: 'dsh-gw-pagehead' },
                  h('div', null, h('h1', { className: 'dsh-gw-pagetitle' }, PANEL_LABEL))),
                h('div', { className: 'dsh-gw-root' },
                  h('p', { className: 'dsh-gw-warn' },
                    h(IconWarningTriangleOutlineRegular, null),
                    'IM 网关页面渲染失败。'),
                  h('p', { className: 'dsh-gw-note' },
                    '通道配置本身没有被改动；重试会重新挂载页面，失败细节在宿主日志里。'),
                  h('div', { className: 'dsh-gw-actions' },
                    h(Button, {
                      size: 'sm',
                      variant: 'outline',
                      onClick: () => this.setState({ failed: false }),
                    }, '重试'))))))
        }
        return h(ImGatewayPage, null)
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // Two registrations, one identity. `order` places the row after the
        // shell's own panels (plugins 0, schedules 10); the label is a thunk so
        // the sidebar re-reads it whenever it re-renders its list.
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 20,
          label: () => PANEL_LABEL,
        }, ImGatewayGlyph))
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
        }, PanelErrorBoundary))
      },
    }
  },
})
