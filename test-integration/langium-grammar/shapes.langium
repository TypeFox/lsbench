/*
 * A small drawing language used as an lsbench integration fixture.
 * Some lines below are deliberately unformatted.
 */
grammar Shapes

interface NamedElement {
    name: string;
}

/** A drawable element with an optional color. */
interface Shape extends NamedElement {
    color?: string;
}

interface Circle extends Shape {
    radius: number;
}

interface Rectangle   extends Shape{
        width: number;
    height: number;
}

interface Group extends NamedElement {
    members: @Shape[];
}

type Element = Circle | Rectangle | Group;

interface Drawing {
    name: string;
    elements: Element[];
}

entry DrawingRule returns Drawing:
    'drawing' name=ID elements+=ElementRule*;

ElementRule returns Element:
    CircleRule | RectangleRule | GroupRule;

CircleRule returns Circle:
    'circle' name=ID colorFragment? 'radius' radius=NUMBER;

RectangleRule   returns Rectangle :
    'rect' name=ID colorFragment?   'size' width=NUMBER 'x' height=NUMBER;

GroupRule returns Group:
    'group' name=ID '{' members+=[Shape:ID]* '}';

fragment colorFragment:
    'color' color=ID;

hidden terminal WS: /\s+/;
terminal ID: /[_a-zA-Z][\w_]*/;
terminal NUMBER returns number: /[0-9]+/;
hidden terminal ML_COMMENT: /\/\*[\s\S]*?\*\//;
hidden terminal SL_COMMENT: /\/\/[^\n\r]*/;
